/**
 * Web 端用户与会话存储。
 *
 * 安全要点：
 *   - 密码只存 scrypt 派生哈希 + 随机盐，绝不存明文/可逆密文（node:crypto，零新增依赖）。
 *   - 校验用 timingSafeEqual，避免时序侧信道。
 *   - 会话是服务端持有的随机 token（Map），登出即删除；进程重启需重新登录（可接受）。
 *   - 登录失败按 IP 限流，抗暴力破解。
 *
 * 持久化 .runtime/web-users.json，tmp+rename 原子写，与项目其它状态文件同构。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { logger } from '../common/logger';

export type Role = 'admin' | 'member' | 'test';

/** 内置可爱头像 logo（前端映射为 emoji 展示）。 */
export const AVATARS = ['fox', 'panda', 'dino', 'rocket', 'unicorn', 'tiger', 'octopus', 'star'] as const;
export type Avatar = (typeof AVATARS)[number];
export const DEFAULT_AVATAR: Avatar = 'star';

export function isAvatar(v: unknown): v is Avatar {
  return typeof v === 'string' && (AVATARS as readonly string[]).includes(v);
}

export interface WebUser {
  id: string;
  username: string;
  /** 玩家昵称（展示/播报用）；缺省回退到 username。 */
  displayName: string;
  /** 头像 logo id，见 AVATARS。 */
  avatar: Avatar;
  passwordHash: string;
  role: Role;
  createdAt: string;
  lastLoginAt?: string;
}

/** 对外暴露的安全视图（不含 passwordHash）。 */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatar: Avatar;
  role: Role;
  createdAt: string;
  lastLoginAt?: string;
}

interface PersistedUsers {
  version: 1;
  users: WebUser[];
}

interface Session {
  uid: string;
  expiresAt: number;
}

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 分钟窗口
const LOGIN_MAX_FAILS = 8; // 窗口内最多失败次数

function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('hex')}`;
}

export interface CreateUserResult {
  ok: boolean;
  error?: string;
  user?: PublicUser;
}

export class UsersStore {
  private readonly file: string;
  private data: PersistedUsers;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, Session>();
  private readonly loginFails = new Map<string, { count: number; resetAt: number }>();

  constructor(file = resolve(process.env.WEB_USERS_FILE || '.runtime/web-users.json')) {
    this.file = file;
    this.data = this.loadFromDisk();
  }

  // ---------------- 查询 ----------------

  hasAnyUser(): boolean {
    return this.data.users.length > 0;
  }

  list(): PublicUser[] {
    return this.data.users.map(toPublic);
  }

  getById(id: string): PublicUser | null {
    const u = this.data.users.find((x) => x.id === id);
    return u ? toPublic(u) : null;
  }

  private findByUsername(username: string): WebUser | undefined {
    const key = username.trim().toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === key);
  }

  countAdmins(): number {
    return this.data.users.filter((u) => u.role === 'admin').length;
  }

  // ---------------- 变更 ----------------

  private validateCredential(username: string, password: string): string | null {
    const name = username.trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) {
      return '用户名需 3~32 位，仅限字母/数字/._-';
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return '密码长度需 6~128 位';
    }
    return null;
  }

  create(
    username: string,
    password: string,
    role: Role,
    opts?: { displayName?: string; avatar?: string },
  ): CreateUserResult {
    const err = this.validateCredential(username, password);
    if (err) return { ok: false, error: err };
    if (role !== 'admin' && role !== 'member' && role !== 'test') return { ok: false, error: '角色不合法' };
    if (this.findByUsername(username)) return { ok: false, error: '用户名已存在' };

    const displayName = normalizeDisplayName(opts?.displayName, username.trim());
    if (!displayName) return { ok: false, error: '玩家昵称需 1~24 个字符' };
    const avatar = isAvatar(opts?.avatar) ? opts!.avatar : DEFAULT_AVATAR;

    const user: WebUser = {
      id: genId('u'),
      username: username.trim(),
      displayName,
      avatar: avatar as Avatar,
      passwordHash: hashPassword(password),
      role,
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    this.persist();
    logger.info('web-users.create', { id: user.id, username: user.username, role, avatar });
    return { ok: true, user: toPublic(user) };
  }

  /** 更新玩家昵称 / 头像。至少提供一项。 */
  updateProfile(
    id: string,
    patch: { displayName?: string; avatar?: string },
  ): { ok: boolean; error?: string } {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return { ok: false, error: '用户不存在' };
    if (patch.displayName !== undefined) {
      const dn = normalizeDisplayName(patch.displayName, '');
      if (!dn) return { ok: false, error: '玩家昵称需 1~24 个字符' };
      u.displayName = dn;
    }
    if (patch.avatar !== undefined) {
      if (!isAvatar(patch.avatar)) return { ok: false, error: '头像不合法' };
      u.avatar = patch.avatar;
    }
    this.persist();
    return { ok: true };
  }

  updatePassword(id: string, password: string): { ok: boolean; error?: string } {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return { ok: false, error: '用户不存在' };
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return { ok: false, error: '密码长度需 6~128 位' };
    }
    u.passwordHash = hashPassword(password);
    this.persist();
    // 改密后踢掉该用户的所有会话
    this.revokeUserSessions(id);
    return { ok: true };
  }

  /**
   * 当前登录用户修改自己的密码：校验旧密码 → 更新 → 撤销该用户所有旧会话 →
   * 重新签发一个新会话 token 返回（调用方 set-cookie，用户无需重新登录）。
   */
  changeOwnPassword(
    id: string,
    oldPassword: string,
    newPassword: string,
  ): { ok: true; token: string } | { ok: false; error: string } {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return { ok: false, error: '用户不存在' };
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
      return { ok: false, error: '新密码长度需 6~128 位' };
    }
    if (!verifyPassword(oldPassword || '', u.passwordHash)) {
      return { ok: false, error: '原密码不正确' };
    }
    if (verifyPassword(newPassword, u.passwordHash)) {
      return { ok: false, error: '新密码不能与原密码相同' };
    }
    u.passwordHash = hashPassword(newPassword);
    this.persist();
    this.revokeUserSessions(id);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { uid: u.id, expiresAt: Date.now() + SESSION_TTL_MS });
    logger.info('web-users.change_own_password', { id });
    return { ok: true, token };
  }

  updateRole(id: string, role: Role): { ok: boolean; error?: string } {
    if (role !== 'admin' && role !== 'member' && role !== 'test') return { ok: false, error: '角色不合法' };
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return { ok: false, error: '用户不存在' };
    // 不允许把最后一个 admin 降级，避免锁死管理入口
    if (u.role === 'admin' && role !== 'admin' && this.countAdmins() <= 1) {
      return { ok: false, error: '至少保留一个管理员' };
    }
    u.role = role;
    this.persist();
    return { ok: true };
  }

  remove(id: string): { ok: boolean; error?: string } {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return { ok: false, error: '用户不存在' };
    if (u.role === 'admin' && this.countAdmins() <= 1) {
      return { ok: false, error: '至少保留一个管理员' };
    }
    this.data.users = this.data.users.filter((x) => x.id !== id);
    this.persist();
    this.revokeUserSessions(id);
    return { ok: true };
  }

  // ---------------- 登录 / 会话 ----------------

  /** 登录限流：返回 true 表示已被限流，应拒绝。 */
  private isRateLimited(ip: string): boolean {
    const rec = this.loginFails.get(ip);
    if (!rec) return false;
    if (Date.now() > rec.resetAt) {
      this.loginFails.delete(ip);
      return false;
    }
    return rec.count >= LOGIN_MAX_FAILS;
  }

  private recordFail(ip: string): void {
    const now = Date.now();
    const rec = this.loginFails.get(ip);
    if (!rec || now > rec.resetAt) {
      this.loginFails.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
      rec.count += 1;
    }
  }

  login(
    username: string,
    password: string,
    ip: string,
  ): { ok: true; token: string; user: PublicUser } | { ok: false; error: string; rateLimited?: boolean } {
    if (this.isRateLimited(ip)) {
      return { ok: false, error: '尝试次数过多，请稍后再试', rateLimited: true };
    }
    const u = this.findByUsername(username || '');
    // 无论用户是否存在都跑一次哈希校验，降低用户枚举侧信道
    const ok = u ? verifyPassword(password || '', u.passwordHash) : verifyPassword(password || '', DUMMY_HASH);
    if (!u || !ok) {
      this.recordFail(ip);
      return { ok: false, error: '用户名或密码错误' };
    }
    this.loginFails.delete(ip);
    u.lastLoginAt = new Date().toISOString();
    this.persist();

    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { uid: u.id, expiresAt: Date.now() + SESSION_TTL_MS });
    return { ok: true, token, user: toPublic(u) };
  }

  logout(token: string | null | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** 校验会话 token，返回对应 PublicUser 或 null。 */
  resolveSession(token: string | null | undefined): PublicUser | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    const u = this.data.users.find((x) => x.id === s.uid);
    if (!u) {
      this.sessions.delete(token);
      return null;
    }
    return toPublic(u);
  }

  private revokeUserSessions(uid: string): void {
    for (const [token, s] of this.sessions.entries()) {
      if (s.uid === uid) this.sessions.delete(token);
    }
  }

  // ---------------- 持久化 ----------------

  private loadFromDisk(): PersistedUsers {
    try {
      if (!existsSync(this.file)) return { version: 1, users: [] };
      const raw = readFileSync(this.file, 'utf8');
      if (!raw.trim()) return { version: 1, users: [] };
      const parsed = JSON.parse(raw) as Partial<PersistedUsers>;
      const rawUsers = Array.isArray(parsed.users) ? (parsed.users as Partial<WebUser>[]) : [];
      // 向后兼容：旧账号可能没有 displayName / avatar，读取时补默认值。
      const users: WebUser[] = rawUsers
        .filter((u) => u && u.id && u.username && u.passwordHash)
        .map((u) => ({
          id: u.id as string,
          username: u.username as string,
          displayName: (u.displayName && u.displayName.trim()) || (u.username as string),
          avatar: isAvatar(u.avatar) ? u.avatar : DEFAULT_AVATAR,
          passwordHash: u.passwordHash as string,
          role: u.role === 'admin' ? 'admin' : 'member',
          createdAt: u.createdAt || new Date().toISOString(),
          lastLoginAt: u.lastLoginAt,
        }));
      logger.info('web-users.loaded', { file: this.file, count: users.length });
      return { version: 1, users };
    } catch (error) {
      logger.warn('web-users.load_failed', { file: this.file, error: (error as Error).message });
      return { version: 1, users: [] };
    }
  }

  private persist(): void {
    const snapshot = JSON.stringify({ version: 1, users: this.data.users }, null, 2);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, snapshot, 'utf8');
        renameSync(tmp, this.file);
      } catch (error) {
        logger.warn('web-users.save_failed', { file: this.file, error: (error as Error).message });
      }
    });
  }
}

function toPublic(u: WebUser): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    avatar: isAvatar(u.avatar) ? u.avatar : DEFAULT_AVATAR,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

/** 规整昵称：去空白，1~24 字符；空则回退到 fallback（可能仍为空）。 */
function normalizeDisplayName(input: string | undefined, fallback: string): string {
  const s = (input ?? '').trim();
  const v = s || fallback.trim();
  if (!v) return '';
  return v.length > 24 ? v.slice(0, 24) : v;
}

// 用户不存在时也跑一次校验用的假哈希（占位，密码为随机值，永不匹配）。
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));
