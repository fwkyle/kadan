import { useResource } from "../resource";
import type { FormSpec } from "../types";
import { ActionForm, ErrorMessage, Loading } from "../ui";
export default function Create({ kind }: { kind: string }) {
  const resource = useResource<{ form: FormSpec }>("create?kind=" + kind, {
    pollMs: 0,
  });
  return (
    <section>
      <nav className="inline-nav" aria-label="상위 화면"><a href={"/?collection=" + (kind === "work" ? "work" : "executions") + "#dashboard"}>{kind === "work" ? "워크 목록으로" : "카드 목록으로"}</a></nav>
      <h1>{kind === "work" ? "새 워크" : "카드 추가"}</h1>
      <p>
        목표와 완료 조건을 기록합니다. 등록 후 담당 배정과 발령은 별도로
        진행합니다.
      </p>
      <nav className="inline-nav">
        <a href="#work-create">새 워크</a>
        <a href="#card-create">카드 추가</a>
      </nav>
      <ErrorMessage error={resource.error} />
      {resource.data ? (
        <ActionForm key={kind} spec={resource.data.form} />
      ) : (
        <Loading />
      )}
    </section>
  );
}
