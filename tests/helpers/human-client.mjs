// 시험용 사람 client: pty에 실제로 attach한 tmux client. 붙기만 하면 client_activity는 client_created와 같고,
// type()으로 키를 눌러야 활동이 갱신된다(격리 소켓 실측 2026-10-17). 제어 모드 client는 키로 세지 않아 쓰지 않는다.
import {spawn, spawnSync} from 'node:child_process';

export function attachHuman(tmuxBin, socket, target) {
  const child = spawn('python3', ['-c', 'import pty,sys;pty.spawn(sys.argv[1:])', tmuxBin, '-u', '-L', socket, 'attach', '-t', target],
    {stdio: ['pipe', 'ignore', 'ignore'], env: {...process.env, TERM: 'xterm-256color'}});
  child.stdin.on('error', () => {});
  const clients = () => spawnSync(tmuxBin, ['-L', socket, 'list-clients', '-t', target, '-F', '#{client_created} #{client_activity}'],
    {encoding: 'utf8'}).stdout.trim();
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const end = Date.now() + 5000;
  while (clients() === '' && Date.now() < end) sleep(20);
  if (clients() === '') { child.kill(); throw new Error('시험 사람 client가 tmux에 붙지 못했다'); }
  return {
    child, clients,
    // 붙은 뒤 delayMs 지나 키를 누른다. 활동은 초 단위라 붙은 시각보다 1초 이상 뒤여야 값이 달라진다.
    type(keys = 'x', delayMs = 2500) {
      sleep(delayMs); child.stdin.write(keys);
      const until = Date.now() + 5000;
      const moved = () => { const [c, a] = clients().split(' ').map(Number); return a > c; };
      while (!moved() && Date.now() < until) sleep(20);
    },
    kill() { child.kill(); },
  };
}
