const guides={
 sessions:['감독·작업자·검수자의 자리와 현재 열려 있는지 확인하는 화면입니다.','이 담당자 아직 켜져 있어? 어떤 도구와 모델을 쓰고 있어?','현재 실행 환경의 세션 조회와 원장의 시작 기록을 대조합니다. 카단으로 시작·종료한 사건은 원장에 남으며, 창이 열려 있다는 사실은 작업 진행이나 완료를 뜻하지 않습니다.'],
 mailbox:['역할끼리 보낸 메시지와 전달 기록을 보는 화면입니다.','감독에게 무엇을 보고했어? 누구에게 전달했어?','발송 기록은 원장에, 메시지 본문은 별도 우편 파일에 저장합니다. 전달 기록은 상대의 처리 완료를 뜻하지 않습니다.'],
 runs:['어떤 카드가 누구에게 맡겨졌고 완료·실패 기록이 있는지 모아 보는 화면입니다.','이 일은 누가 맡았고 결과가 나왔어?','원장의 발령(send)·완료(done) 기록을 카드·역할별로 묶은 보기입니다. 별도 실행 원본 파일은 없으며, 같은 역할·카드에 재발령하면 최신 실행 상태를 보여줍니다. 같은 원본의 전체 사건은 사건순 보기에서 확인합니다.'],
 ledger:['세션 시작·발령·완료·종료·감시 알림 등 시스템 사건의 원문을 보는 화면입니다.','왜 이런 상태가 됐지? 실제로 어떤 사건이 있었지?','작업별 보기와 같은 원본인 시스템 사건 저장소(SQLite)를 읽으며 사건을 뒤에 추가해 보존합니다. 카드 상태 변경 이유는 카드 변경 이력에 남습니다. SQLite로 전환한 저장소에서는 같은 DB 안에 보존합니다. 터미널의 모든 대화·명령 출력을 담는 기록은 아닙니다.']
};
export function activityGuide(view){const [meaning,when,source]=guides[view];return `<div class="activity-guide"><p><strong>의미</strong> · ${meaning}</p><p><strong>볼 때</strong> · “${when}”</p><details><summary>어디에 기록되나요?</summary><p>${source}</p></details></div>`;}
export const activityGuideStyle='.activity-guide{padding:12px 16px;margin:0 0 20px;background:#f5f8f5;border-left:3px solid #5b826d;border-radius:4px}.activity-guide p{overflow-wrap:anywhere}.activity-guide details{font-size:13px;color:#5e6b62}';
