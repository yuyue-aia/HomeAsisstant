/**
 * 音乐能力冒烟脚本。
 * 跑：search → 过滤 → play → state 验证 → 5s 后 stop。
 *
 * 用法：
 *   npx tsx scripts/music-smoke.ts            # 默认搜"稻香" + artist="周杰伦"
 *   npx tsx scripts/music-smoke.ts 起风了 买辣椒也用券
 */

import { getMusicService } from '../src/services/music/music-service';

async function main(): Promise<void> {
  const [query = '稻香', artist = '周杰伦'] = process.argv.slice(2);
  const userInput = `用户请求播放${artist ? artist + '的' : ''}${query}`;

  const svc = getMusicService();
  // init 是幂等 promise——这里 await 确保 loggedIn 探测就绪
  await svc.init();

  console.log(`\n[1/4] 搜 "${query}" (artist=${artist || '∅'})`);
  const tracks = await svc.searchTracks(query, userInput, artist || undefined);
  if (!tracks.length) {
    console.error('  ❌ 搜不到可播曲');
    process.exit(1);
  }
  console.log(`  ✓ 命中 ${tracks.length} 首，取首条：`);
  const pick = tracks[0];
  console.log(`    name=${pick.name} | artists=${pick.artists.join(',')} | vip=${pick.vipOnly}`);

  console.log(`\n[2/4] 播放...`);
  const state = await svc.playTrack(pick);
  console.log(`  ✓ status=${state.status} title=${state.title} progress=${state.progress}`);

  console.log(`\n[3/4] 5 秒后查状态...`);
  await sleep(5000);
  const np = await svc.nowPlaying();
  const st2 = await svc.getState();
  console.log(`  ✓ nowPlaying=${JSON.stringify(np)} status=${st2.status} progress=${st2.progress}`);

  console.log(`\n[4/4] 停止`);
  await svc.stop();
  console.log(`  ✓ stopped`);

  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('❌ 冒烟失败:', e?.message ?? e);
  if (e?.reason) console.error('   reason:', e.reason);
  process.exit(1);
});
