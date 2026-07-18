/**
 * 家庭游戏管家 Web 服务（node:http，零第三方框架）。
 *
 * 组装：UsersStore（登录/会话/多账号）+ GameConfigStore（可编辑配置）+
 *       GameConsoleController（复用现有游戏逻辑单例）。
 *
 * 路由：/api/auth/* /api/game/* /api/config /api/users/* /api/device/power
 * 其余路径交给静态托管（public/app 下的单页 SPA）。
 *
 * 安全：
 *   - 会话 cookie（HttpOnly + SameSite=Strict），角色鉴权中间件；
 *   - 登录限流在 UsersStore 内实现；
 *   - 写操作要求 JSON content-type（配合 SameSite 抵御 CSRF）；
 *   - 云厂商密钥永不下发前端。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { logger } from '../common/logger';
import { getGameConsoleController } from '../services/game-console-controller';
import { GameConfigStore, validateConfig } from './config-store';
import {
  clearSessionCookie,
  clientIp,
  parseCookies,
  parseJsonBody,
  sendJson,
  sendNoContent,
  serveStatic,
  setSessionCookie,
} from './http-utils';
import { AVATARS, UsersStore, type PublicUser, type Role } from './users-store';

const COOKIE_NAME = 'ha_sess';
const SESSION_MAX_AGE_SEC = 7 * 24 * 3600;
const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface WebServerOptions {
  port: number;
  host: string;
  staticDir: string;
}

export function loadWebServerOptions(): WebServerOptions {
  const port = Number(process.env.WEB_PORT || 8787);
  return {
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 8787,
    // 默认只监听局域网/本机，避免误暴露公网
    host: process.env.WEB_HOST || '0.0.0.0',
    staticDir: resolve(process.env.WEB_STATIC_DIR || 'public/app'),
  };
}

export class WebServer {
  private readonly opts: WebServerOptions;
  private readonly users: UsersStore;
  private readonly configStore: GameConfigStore;
  private server: Server | null = null;
  /** 是否记录每个请求的访问日志（默认开，WEB_ACCESS_LOG=off 关闭）。 */
  private readonly accessLog: boolean;

  constructor(opts: WebServerOptions = loadWebServerOptions()) {
    this.opts = opts;
    this.users = new UsersStore();
    this.configStore = new GameConfigStore();
    this.accessLog = (process.env.WEB_ACCESS_LOG || '').trim().toLowerCase() !== 'off';
    // 启动时把持久化配置应用到运行中的 controller，保证与语音链路一致。
    getGameConsoleController().applyRuntimeConfig(this.configStore.get());
  }

  start(): void {
    if (this.server) return;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        logger.error('web.unhandled', { error: (error as Error).message });
        if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
      });
    });
    this.server.listen(this.opts.port, this.opts.host, () => {
      const logDir = resolve(process.env.LOG_DIR || 'logs');
      logger.info('web.listen', { host: this.opts.host, port: this.opts.port, accessLog: this.accessLog });
      // eslint-disable-next-line no-console
      console.log(`[web] 游戏管家已启动: http://${this.opts.host}:${this.opts.port}`);
      // eslint-disable-next-line no-console
      console.log(`[web] 结构化日志: ${logDir}/app-YYYY-MM-DD.log（访问日志 message=web.request${this.accessLog ? '，已开启' : '，已关闭'}）`);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  // ---------------- 请求分发 ----------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // 访问日志：响应结束时记录一行（method/path/状态码/耗时/IP/用户）
    if (this.accessLog) {
      const startedAt = Date.now();
      res.on('finish', () => {
        const meta: Record<string, unknown> = {
          method,
          path,
          status: res.statusCode,
          ms: Date.now() - startedAt,
          ip: clientIp(req),
        };
        const u = this.currentUser(req);
        if (u) meta.user = u.username;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger[level]('web.request', meta);
      });
    }

    if (path.startsWith('/api/')) {
      await this.handleApi(req, res, method, path);
      return;
    }

    // 静态资源（SPA）
    if (method === 'GET') {
      const served = serveStatic(res, this.opts.staticDir, path, true);
      if (served) return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    // ---- 无需登录的端点 ----
    if (path === '/api/auth/me' && method === 'GET') {
      const me = this.currentUser(req);
      sendJson(res, 200, { user: me, needsBootstrap: !this.users.hasAnyUser() });
      return;
    }
    if (path === '/api/auth/bootstrap' && method === 'POST') {
      return this.handleBootstrap(req, res);
    }
    if (path === '/api/auth/login' && method === 'POST') {
      return this.handleLogin(req, res);
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = parseCookies(req)[COOKIE_NAME];
      this.users.logout(token);
      clearSessionCookie(res, COOKIE_NAME);
      sendNoContent(res);
      return;
    }

    // ---- 以下均需登录 ----
    const me = this.currentUser(req);
    if (!me) {
      sendJson(res, 401, { error: '请先登录' });
      return;
    }

    // 带 body 的写操作要求 JSON content-type（配合 SameSite=Strict 防 CSRF）；
    // DELETE 无请求体，豁免该检查。
    if ((method === 'POST' || method === 'PUT') && !this.isJsonRequest(req)) {
      sendJson(res, 415, { error: '需要 application/json 请求' });
      return;
    }

    // 内置头像列表（所有已登录用户）
    if (path === '/api/meta' && method === 'GET') {
      sendJson(res, 200, { avatars: AVATARS });
      return;
    }
    // 修改自己的密码（所有已登录用户，含普通成员）
    if (path === '/api/auth/change-password' && method === 'POST') {
      return this.handleChangeOwnPassword(req, res, me);
    }
    // 修改自己的昵称 / 头像（所有已登录用户）
    if (path === '/api/auth/profile' && method === 'PUT') {
      return this.handleUserProfile(req, res, me.id);
    }

    // 游戏控制（member+）：玩家身份跟随登录账号
    if (path === '/api/game/status' && method === 'GET') {
      sendJson(res, 200, this.gameStatus(me));
      return;
    }
    if (path === '/api/game/start' && method === 'POST') {
      return this.handleGameStart(req, res, me);
    }
    if (path === '/api/game/stop' && method === 'POST') {
      return this.handleGameStop(req, res, me);
    }

    // ---- 以下需要 admin ----
    if (path === '/api/config' && method === 'GET') {
      if (!this.requireAdmin(me, res)) return;
      sendJson(res, 200, this.configView());
      return;
    }
    if (path === '/api/config' && method === 'PUT') {
      if (!this.requireAdmin(me, res)) return;
      return this.handleConfigSave(req, res);
    }
    if (path === '/api/users' && method === 'GET') {
      if (!this.requireAdmin(me, res)) return;
      sendJson(res, 200, { users: this.users.list() });
      return;
    }
    if (path === '/api/users' && method === 'POST') {
      if (!this.requireAdmin(me, res)) return;
      return this.handleUserCreate(req, res);
    }
    const userMatch = path.match(/^\/api\/users\/([A-Za-z0-9_.-]+)(\/password|\/role|\/profile|\/bonus|\/quota)?$/);
    if (userMatch) {
      if (!this.requireAdmin(me, res)) return;
      const id = userMatch[1];
      const sub = userMatch[2];
      if (method === 'DELETE' && !sub) return this.handleUserDelete(res, id, me);
      if (method === 'PUT' && sub === '/password') return this.handleUserPassword(req, res, id);
      if (method === 'PUT' && sub === '/role') return this.handleUserRole(req, res, id, me);
      if (method === 'PUT' && sub === '/profile') return this.handleUserProfile(req, res, id);
      if (method === 'POST' && sub === '/bonus') return this.handleUserBonus(req, res, id);
      if (method === 'POST' && sub === '/quota') return this.handleUserSetTime(req, res, id);
    }
    if (path === '/api/device/power' && method === 'POST') {
      if (!this.requireAdmin(me, res)) return;
      return this.handleDevicePower(req, res);
    }

    sendJson(res, 404, { error: 'not found' });
  }

  // ---------------- auth handlers ----------------

  private async handleBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.users.hasAnyUser()) {
      sendJson(res, 409, { error: '系统已初始化' });
      return;
    }
    const body = await this.readJson(req, res);
    if (!body) return;
    const { username, password } = body as { username?: string; password?: string };
    const created = this.users.create(String(username ?? ''), String(password ?? ''), 'admin');
    if (!created.ok) {
      sendJson(res, 400, { error: created.error });
      return;
    }
    // 直接登录
    const login = this.users.login(String(username), String(password), clientIp(req));
    if (login.ok) {
      setSessionCookie(res, COOKIE_NAME, login.token, SESSION_MAX_AGE_SEC);
      sendJson(res, 200, { user: login.user });
    } else {
      sendJson(res, 200, { user: created.user });
    }
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { username, password } = body as { username?: string; password?: string };
    const result = this.users.login(String(username ?? ''), String(password ?? ''), clientIp(req));
    if (!result.ok) {
      sendJson(res, result.rateLimited ? 429 : 401, { error: result.error });
      return;
    }
    setSessionCookie(res, COOKIE_NAME, result.token, SESSION_MAX_AGE_SEC);
    sendJson(res, 200, { user: result.user });
  }

  private async handleChangeOwnPassword(
    req: IncomingMessage,
    res: ServerResponse,
    me: PublicUser,
  ): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { oldPassword, newPassword } = body as { oldPassword?: string; newPassword?: string };
    const r = this.users.changeOwnPassword(me.id, String(oldPassword ?? ''), String(newPassword ?? ''));
    if (!r.ok) {
      sendJson(res, 400, { error: r.error });
      return;
    }
    // 续签会话，避免改密后被自己踢下线
    setSessionCookie(res, COOKIE_NAME, r.token, SESSION_MAX_AGE_SEC);
    sendJson(res, 200, { ok: true });
  }

  // ---------------- game handlers ----------------

  /** 用所有账号作为玩家列表汇总配额，并标注"我"是谁；附带每个玩家的头像。 */
  private gameStatus(me: PublicUser) {
    const all = this.users.list();
    const metaById = new Map(all.map((u) => [u.id, u]));
    const players = all.map((u) => ({ id: u.id, label: u.displayName }));
    const status = getGameConsoleController().statusForPlayers(players);
    const quotas = status.quotas.map((q) => {
      const u = metaById.get(q.child);
      return { ...q, avatar: u ? u.avatar : 'star', role: u ? u.role : 'member' };
    });
    const active = status.active
      ? { ...status.active, avatar: metaById.get(status.active.child)?.avatar || 'star' }
      : null;
    return { ...status, quotas, active, meId: me.id };
  }

  /** 开始游戏/看电视：玩家就是当前登录账号，activity 决定通电哪些接口。 */
  private async handleGameStart(req: IncomingMessage, res: ServerResponse, me: PublicUser): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { minutes, activity } = body as { minutes?: number; activity?: string };
    const act = activity === 'tv' ? 'tv' : 'game';
    const result = await getGameConsoleController().start(me.id, Number(minutes), {
      label: me.displayName,
      activity: act,
    });
    sendJson(res, result.ok ? 200 : 400, result);
  }

  /** 停止游戏：成员只能停自己的会话，管理员可停任意。 */
  private async handleGameStop(req: IncomingMessage, res: ServerResponse, me: PublicUser): Promise<void> {
    const ctrl = getGameConsoleController();
    const active = ctrl.getQuotaService().getActiveSession();
    if (!active) {
      sendJson(res, 400, { ok: false, message: '现在没有人在玩游戏哦。' });
      return;
    }
    if (me.role !== 'admin' && active.child !== me.id) {
      sendJson(res, 403, { error: '只能停止你自己的游戏' });
      return;
    }
    const result = await ctrl.stop(null);
    sendJson(res, result.ok ? 200 : 400, result);
  }

  // ---------------- config handlers ----------------

  private configView() {
    const cfg = this.configStore.get();
    return { config: cfg, weekdayLabels: WEEKDAY_LABEL };
  }

  private async handleConfigSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const parsed = validateConfig((body as { config?: unknown }).config ?? body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const saved = this.configStore.save(parsed.value);
    // 即时热更新到运行中的 controller
    getGameConsoleController().applyRuntimeConfig(saved);
    logger.info('web.config_saved', { config: saved });
    sendJson(res, 200, { config: saved });
  }

  // ---------------- users handlers ----------------

  private async handleUserCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { username, password, role, displayName, avatar } = body as {
      username?: string; password?: string; role?: string; displayName?: string; avatar?: string;
    };
    const r = this.users.create(String(username ?? ''), String(password ?? ''), (role as Role) ?? 'member', {
      displayName: displayName != null ? String(displayName) : undefined,
      avatar: avatar != null ? String(avatar) : undefined,
    });
    if (!r.ok) {
      sendJson(res, 400, { error: r.error });
      return;
    }
    sendJson(res, 201, { user: r.user });
  }

  private async handleUserProfile(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { displayName, avatar } = body as { displayName?: string; avatar?: string };
    const r = this.users.updateProfile(id, {
      displayName: displayName != null ? String(displayName) : undefined,
      avatar: avatar != null ? String(avatar) : undefined,
    });
    if (!r.ok) {
      sendJson(res, 400, { error: r.error });
      return;
    }
    sendJson(res, 200, { user: this.users.getById(id) });
  }

  /** 管理员给指定玩家临时加时（正数加、负数收回，仅当天有效）。 */
  private async handleUserBonus(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const u = this.users.getById(id);
    if (!u) {
      sendJson(res, 404, { error: '用户不存在' });
      return;
    }
    const { minutes } = body as { minutes?: number };
    const r = getGameConsoleController().addBonus(id, Number(minutes));
    if (!r.ok) {
      sendJson(res, 400, { error: r.error === 'invalid_minutes' ? '请输入有效的加时分钟数' : '玩家不存在' });
      return;
    }
    logger.info('web.bonus', { targetId: id, minutes: Number(minutes), by: '', remaining: r.remainingMinutes });
    sendJson(res, 200, { remainingMinutes: r.remainingMinutes, bonusMinutes: r.bonusMinutes });
  }

  /** 管理员直接设定指定玩家今日总时间（总额）为具体分钟数（精确设置，仅当天有效）。 */
  private async handleUserSetTime(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const u = this.users.getById(id);
    if (!u) {
      sendJson(res, 404, { error: '用户不存在' });
      return;
    }
    const { totalMinutes } = body as { totalMinutes?: number };
    const r = getGameConsoleController().setTotal(id, Number(totalMinutes));
    if (!r.ok) {
      sendJson(res, 400, { error: r.error === 'invalid_minutes' ? '请输入有效的分钟数（0~1440）' : '玩家不存在' });
      return;
    }
    logger.info('web.set_time', { targetId: id, minutes: Number(totalMinutes), total: r.totalMinutes, remaining: r.remainingMinutes });
    sendJson(res, 200, { totalMinutes: r.totalMinutes, remainingMinutes: r.remainingMinutes, bonusMinutes: r.bonusMinutes });
  }

  private handleUserDelete(res: ServerResponse, id: string, me: PublicUser): void {
    if (id === me.id) {
      sendJson(res, 400, { error: '不能删除当前登录的自己' });
      return;
    }
    const r = this.users.remove(id);
    if (!r.ok) {
      sendJson(res, 400, { error: r.error });
      return;
    }
    sendNoContent(res);
  }

  private async handleUserPassword(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { password } = body as { password?: string };
    const r = this.users.updatePassword(id, String(password ?? ''));
    if (!r.ok) {
      sendJson(res, 400, { error: r.error });
      return;
    }
    sendNoContent(res);
  }

  private async handleUserRole(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    me: PublicUser,
  ): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { role } = body as { role?: string };
    if (id === me.id && role !== 'admin') {
      sendJson(res, 400, { error: '不能取消自己的管理员权限' });
      return;
    }
    const r = this.users.updateRole(id, (role as Role) ?? 'member');
    if (!r.ok) {
      sendJson(res, 400, { error: r.error });
      return;
    }
    sendNoContent(res);
  }

  // ---------------- device handlers ----------------

  private async handleDevicePower(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req, res);
    if (!body) return;
    const { on } = body as { on?: boolean };
    const controller = getGameConsoleController();
    // 有孩子在玩时禁止手动断电，避免误抢会话
    if (on === false && controller.hasActiveSession()) {
      sendJson(res, 409, { error: '有孩子正在玩，请先停止游戏再断电' });
      return;
    }
    const r = on ? await controller.forcePowerOn() : await controller.forcePowerOff();
    if (!r.ok) {
      sendJson(res, 502, { error: r.error === 'plug_not_configured' ? '插板未配置' : '设备控制失败' });
      return;
    }
    sendJson(res, 200, { ok: true, on: !!on });
  }

  // ---------------- helpers ----------------

  private currentUser(req: IncomingMessage): PublicUser | null {
    const token = parseCookies(req)[COOKIE_NAME];
    return this.users.resolveSession(token);
  }

  private requireAdmin(me: PublicUser, res: ServerResponse): boolean {
    if (me.role !== 'admin') {
      sendJson(res, 403, { error: '需要管理员权限' });
      return false;
    }
    return true;
  }

  private isJsonRequest(req: IncomingMessage): boolean {
    const ct = (req.headers['content-type'] || '').toString().toLowerCase();
    return ct.includes('application/json');
  }

  /** 读 JSON body；出错时已回写响应并返回 null。 */
  private async readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
    try {
      return await parseJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: (error as Error).message });
      return null;
    }
  }
}

// ---------------- 单例 ----------------

let singleton: WebServer | null = null;

export function getWebServer(): WebServer {
  if (!singleton) singleton = new WebServer();
  return singleton;
}
