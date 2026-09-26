import { useResource } from "../resource";
import type { FormSpec } from "../types";
import { ActionForm, ErrorMessage, Loading } from "../ui";
export default function Create({ kind }: { kind: string }) {
  const resource = useResource<{ form: FormSpec }>("create?kind=" + kind, {
    pollMs: 0,
  });
  return (
    <section>
      <h1>{kind === "work" ? "새 업무" : "새 실행 초안"}</h1>
      <p>
        목표와 완료 조건을 기록합니다. 등록 후 담당 배정과 발령은 별도로
        진행합니다.
      </p>
      <nav className="inline-nav">
        <a href="#work-create">업무 카드</a>
        <a href="#card-create">실행 초안</a>
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
