// Why: 요약이 없는 서버 손실에서도 기반 알림을 보존하고, 울림은 즉시 보낸다.
export function bufferBaseNotices(warn = console.error) {
  const pending = [];
  return {
    wrap: ops => ({...ops,
      notify: (message, options = {}) => {
        if (options.ring) return ops.notify(message, options);
        pending.push({message, options, ops});
        // 아직 전송 결과가 아니다. finishRevive가 실패 로그나 가짜 영수증을 만들지 않게 한다.
        return {};
      },
      record: entry => {
        const item = pending.find(item => !item.entry);
        if (item && entry.kind === 'revive' && entry.result === 'started') {
          item.entry = {...entry, t: new Date().toISOString()};
        } else ops.record(entry);
      },
    }),
    lines: () => pending.map(item => item.message),
    flush: summary => {
      for (const item of pending.splice(0)) {
        let receipt = summary?.receipt;
        if (!summary) {
          try { receipt = item.ops.notify(item.message, item.options); }
          catch { receipt = {via: 'none', reason: '기반 알림 전달 실패'}; }
        }
        if (!item.entry) continue;
        const notice = receipt?.error ? 'none' : receipt?.via ?? 'none';
        const reason = receipt?.error ?? receipt?.reason;
        try {
          item.ops.record({...item.entry, notice,
            ...(reason ? {noticeReason: reason} : {}),
            ...(summary ? {noticeSummary: summary.id} : {})});
        } catch { warn('기반 되살리기 알림 결과 기록 실패'); }
      }
    },
  };
}
