// 시험용 사람 client: pty에 실제로 attach한 tmux client. 붙기만 하면 client_activity는 client_created와 같고,
// type()으로 키를 눌러야 활동이 갱신된다(격리 소켓 실측 2026-10-17). 제어 모드 client는 키로 세지 않아 쓰지 않는다.
import {spawn, spawnSync} from 'node:child_process';

export function attachHuman(tmuxBin, socket, target) {
  const child = spawn('python3', ['-c', 'import pty,sys;pty.spawn(sys.argv[1:])', tmuxBin, '-L', socket, 'attach', '-t', target],
    {stdio: ['pipe', 'ignore', 'ignore']});
  const clients = () => spawnSync(tmuxBin, ['-L', socket, 'list-clients', '-t', target, '-F', '#{client_created} #{client_activity}'],
    {encoding: 'utf8'}).stdout.trim();
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const end = Date.now() + 5000;
  while (clients() === '' && Date.now() < end) sleep(20);
  return {
    child, clients,
    // 붙은 지 2초 넘은 뒤 키를 눌러야 입력으로 센다(초 단위 시각).
    type(keys = 'x') {
      sleep(2500); child.stdin.write(keys);
      const until = Date.now() + 5000;
      const moved = () => { const [c, a] = clients().split(' ').map(Number); return a - c > 1; };
      while (!moved() && Date.now() < until) sleep(20);
    },
    kill() { child.kill(); },
  };
}
