// 가짜 디스코드 봇 REST 서버(루프백 http). 시험 프로세스 안에서 띄운다 — 받기·보내기 코드는 비동기라 같은 프로세스에서 응답해도 막히지 않는다.
// 모든 값은 가짜다. 요청은 requests에 {method, path, auth, body}로 쌓인다.
// 실패 주입: server.inject({match: /GET \/channels\/.*\/messages/, status: 429, body: {retry_after: 0.01}, times: 1, destroy: false}).
import http from 'node:http';

export const FAKE = {
  token: 'FAKE-BOT-TOKEN-ab12cd', appId: '660000000000000001', userId: '770000000000000001', otherId: '770000000000000002',
  botId: '660000000000000009', hookId: '880000000000000002', hookToken: 'FAKE-HOOK-TOKEN-ef34gh', guildId: '550000000000000001',
  channelId: '440000000000000001', otherChannelId: '440000000000000077',
};
const EPOCH = 1420070400000n;

export async function startFakeDiscord({intent = true} = {}) {
  let seq = (BigInt(Date.now()) - EPOCH) << 22n;
  // 현재 시각보다 뒤처지지 않게 올린다(실제 스노플레이크처럼 시각 순서가 맞는다). 같은 밀리초 안에서는 1씩 늘린다.
  const nextId = () => { const t = (BigInt(Date.now()) - EPOCH) << 22n; seq = seq < t ? t : seq + 1n; return String(seq); };
  const requests = [], rules = [];
  const messages = new Map([[FAKE.channelId, []]]);   // 채널·스레드 id → 메시지 배열
  const threads = new Map();                          // 스레드 id → {id, parent_id, type, name, archived, last_message_id}
  const channels = new Map([
    [FAKE.channelId, {id: FAKE.channelId, type: 0, guild_id: FAKE.guildId}],
    [FAKE.otherChannelId, {id: FAKE.otherChannelId, type: 0, guild_id: FAKE.guildId}],
  ]);
  messages.set(FAKE.otherChannelId, []);
  const guild = {roles: [{id: FAKE.guildId, permissions: '0'}], memberRoles: []};   // 봇 권한 계산용(checkChat의 Manage Threads 줄)
  const webhooks = new Map([[`${FAKE.hookId}/${FAKE.hookToken}`, FAKE.channelId]]); // 웹훅 id/token → 채널 id

  const send = (res, status, json) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(json === undefined ? '' : JSON.stringify(json)); };
  const lastOf = id => messages.get(id)?.at(-1)?.id ?? null;
  const channelView = id => {
    const t = threads.get(id), c = channels.get(id) ?? t;
    return c && {...c, last_message_id: lastOf(id)};
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8'), url = new URL(req.url, 'http://x');
      const body = text ? JSON.parse(text) : undefined;
      requests.push({method: req.method, path: url.pathname + url.search, auth: req.headers.authorization ?? null, body});
      const key = `${req.method} ${url.pathname}`;
      const rule = rules.find(r => r.match.test(key) && r.times > 0);
      if (rule) { rule.times--; if (rule.destroy) return req.socket.destroy(); return send(res, rule.status, rule.body); }
      const p = url.pathname.split('/').filter(Boolean);
      const m = req.method;
      if (m === 'GET' && p[0] === 'webhooks' && webhooks.has(`${p[1]}/${p[2]}`)) return send(res, 200, {id: p[1], channel_id: webhooks.get(`${p[1]}/${p[2]}`)});
      if (m === 'GET' && p[0] === 'guilds' && p[2] === 'members') return send(res, 200, {user: {id: p[3]}, roles: guild.memberRoles});
      if (m === 'GET' && p[0] === 'guilds' && p[2] === 'roles') return send(res, 200, guild.roles);
      if (m === 'GET' && p[0] === 'users' && p[1] === '@me') return send(res, 200, {id: FAKE.botId, bot: true});
      if (m === 'GET' && p[0] === 'applications' && p[1] === '@me') return send(res, 200, {id: FAKE.appId, flags: intent ? 1 << 18 : 0});
      if (m === 'GET' && p[0] === 'guilds' && p[2] === 'threads') return send(res, 200, {threads: [...threads.values()].filter(t => !t.archived && t.guild_id === p[1]).map(t => ({...t, last_message_id: lastOf(t.id)}))});
      if (p[0] === 'channels') {
        const id = p[1];
        if (p.length === 2 && m === 'GET') return channelView(id) ? send(res, 200, channelView(id)) : send(res, 404, {code: 10003});
        if (p.length === 2 && m === 'PATCH') {
          const t = threads.get(id);
          if (!t) return send(res, 403, {code: 50001});
          if (body.name) t.name = body.name;
          if (body.archived) t.archived = true;
          return send(res, 200, t);
        }
        if (p[2] === 'messages' && p.length === 3 && m === 'GET') {
          if (!messages.has(id)) return send(res, 404, {code: 10003});
          const after = BigInt(url.searchParams.get('after') ?? '0'), limit = Number(url.searchParams.get('limit') ?? 50);
          // 디스코드처럼 after 뒤 가장 오래된 limit개를 최신순으로 준다.
          const page = messages.get(id).filter(x => BigInt(x.id) > after).slice(0, limit).reverse();
          return send(res, 200, page);
        }
        if (p[2] === 'messages' && p.length === 3 && m === 'POST') {
          if (!messages.has(id)) return send(res, 404, {code: 10003});
          if (String(body.content).length > 2000) return send(res, 400, {code: 50035});
          const msg = {id: nextId(), channel_id: id, type: 0, content: body.content, author: {id: FAKE.botId, bot: true}, timestamp: new Date().toISOString(), _body: body};
          messages.get(id).push(msg);
          return send(res, 200, msg);
        }
        if (p[2] === 'messages' && p.length === 4 && m === 'GET') {
          const msg = messages.get(id)?.find(x => x.id === p[3]);
          return msg ? send(res, 200, msg) : send(res, 404, {code: 10008});
        }
        if (p[2] === 'messages' && p.length === 4 && m === 'PATCH') {
          const msg = messages.get(id)?.find(x => x.id === p[3]);
          if (!msg) return send(res, 404, {code: 10008});
          if (msg.author.id !== FAKE.botId) return send(res, 403, {code: 50005});
          msg.content = body.content; msg._body = body;
          return send(res, 200, msg);
        }
        if (p[2] === 'messages' && p[4] === 'threads' && m === 'POST') {
          if (threads.has(p[3])) return send(res, 400, {code: 160004});
          if (!messages.get(id)?.some(x => x.id === p[3])) return send(res, 404, {code: 10008});
          const t = {id: p[3], parent_id: id, type: 11, guild_id: FAKE.guildId, name: body.name};
          threads.set(t.id, t); messages.set(t.id, []);
          return send(res, 201, t);
        }
        if (p[2] === 'messages' && p[4] === 'reactions' && m === 'PUT') {
          const msg = messages.get(id)?.find(x => x.id === p[3]);
          if (!msg) return send(res, 404, {code: 10008});
          (msg.reactions ??= []).push({emoji: {name: decodeURIComponent(p[5])}, me: true, count: 1});
          return send(res, 204);
        }
      }
      send(res, 404, {code: 0, message: 'fake: 모르는 경로'});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests, threads, messages, guild,
    inject: rule => rules.push({times: 1, status: 500, ...rule}),
    // 채널(또는 스레드)에 메시지를 넣는다. 반환: 메시지
    add(channelId, extra = {}) {
      const msg = {id: nextId(), channel_id: channelId, type: 0, content: 'hello', author: {id: FAKE.userId}, timestamp: new Date().toISOString(), ...extra};
      messages.get(channelId).push(msg);
      return msg;
    },
    // #비서 본문 메시지에 스레드를 만들어 둔다(스레드 ID = 메시지 ID).
    addThread(parentMsg, name = 'topic') {
      const t = {id: parentMsg.id, parent_id: FAKE.channelId, type: 11, guild_id: FAKE.guildId, name};
      threads.set(t.id, t); messages.set(t.id, []);
      return t;
    },
    // 레포 포럼 채널(type 15)과 그 웹훅을 만든다. 반환: {id, hookId, hookToken, name}. 비밀 파일에는 DISCORD_WEBHOOK_URL_<이름>으로 넣는다.
    addForum(name, {guildId = FAKE.guildId, type = 15, overwrites = []} = {}) {
      const id = nextId(), hookId = nextId(), hookToken = `FAKE-HOOK-${name}-${hookId.slice(-4)}`;
      channels.set(id, {id, type, guild_id: guildId, name, permission_overwrites: overwrites}); messages.set(id, []);
      webhooks.set(`${hookId}/${hookToken}`, id);
      return {id, hookId, hookToken, name, url: `https://discord.com/api/webhooks/${hookId}/${hookToken}`};
    },
    // 포럼에 새 글(스레드)을 올린다. 포럼 글의 id는 시작 글의 id와 같고 시작 글은 그 스레드 안에 있다. author를 주면 그 사람이 쓴 것으로 한다.
    // 기본 작성자는 웹훅(봇)이라 kyle 글로 읽히지 않는다.
    addForumPost(forum, {name = 'post', content = '알림', author, webhook = true, guildId = FAKE.guildId} = {}) {
      const id = nextId();
      const t = {id, parent_id: forum.id, type: 11, guild_id: guildId, name};
      threads.set(id, t);
      messages.set(id, [{id, channel_id: id, type: 0, content, timestamp: new Date().toISOString(),
        ...(webhook && !author ? {author: {id: forum.hookId, bot: true}, webhook_id: forum.hookId} : {author: author ?? {id: FAKE.userId}})}]);
      return t;
    },
    count: re => requests.filter(r => re.test(`${r.method} ${r.path}`)).length,
    async close() { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
