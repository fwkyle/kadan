import { ActionForm, ErrorMessage, time } from "../ui";

export type UserAttentionItem = {
  id: string;
  type: "mail" | "alert";
  title: string;
  from: string;
  at: string;
  body: string | null;
  waiting?: boolean;
};

export function UserAttention({ items, error }: { items: UserAttentionItem[]; error: string | null }) {
  return <section className="user-attention" aria-label="내 확인 필요">
    <h2>내 확인 필요 {error ? "모름" : `${items.length}건`}</h2>
    <ErrorMessage error={error}/>
    {items.map(item => <article className="work-tile" key={`${item.type}:${item.id}`}>
      <h3>{item.title} · {item.from}</h3>
      <p className="user-attention__body">{item.body ?? "본문을 읽지 못했습니다. 확인 처리하지 마세요."}</p>
      <small>{time(item.at)}</small>
      {item.type === "mail" ? <ActionForm spec={{
        action: item.waiting ? "/attention/reply" : "/attention/ack",
        title: item.waiting ? "답변 보관" : "확인했습니다",
        disabled: item.body === null,
        fields: [
          {name:"id",label:"우편 ID",value:item.id,type:"hidden",options:null,required:true},
          ...(item.waiting ? [{name:"text",label:"답변",value:"",type:"textarea" as const,options:null,required:true}] : []),
        ],
      }}/> : <p>관련 역할의 현재 상태를 확인해 주세요. 문제가 해소되면 목록에서 빠집니다.</p>}
      {item.type === "mail" && item.waiting && <p>답변은 요청자의 우편함에 보관합니다. 보관은 실행·완료가 아닙니다.</p>}
    </article>)}
    {!error && !items.length && <p className="empty">확인을 기다리는 항목이 없습니다.</p>}
  </section>;
}
