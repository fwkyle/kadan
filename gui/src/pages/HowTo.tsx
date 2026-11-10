import { useResource } from "../resource";
import { DocumentContent, ErrorMessage, Loading } from "../ui";

type HowToData = { title: string | null; html: string | null; error: string | null };

// 길잡이: docs/how-to.md를 읽기 전용으로 보인다. 들어올 때 한 번만 읽고 주기 조회도, 탭 재표시 조회도 없다.
export default function HowTo() {
  const resource = useResource<HowToData>("how-to", {
    pollMs: 0,
    staleMs: 300_000,
    refreshOnResume: false,
  });
  const data = resource.data;
  return (
    <section className="howto-view">
      <h1>{data?.title || "길잡이"}</h1>
      <p className="howto-source">
        원본 문서 <code>docs/how-to.md</code> · 읽기 전용
      </p>
      <ErrorMessage error={resource.error} retry={() => void resource.refresh(true)} />
      {!data && !resource.error ? (
        <Loading />
      ) : data?.html ? (
        <DocumentContent html={data.html} />
      ) : (
        data?.error && (
          <p className="empty" role="status">
            {data.error}
          </p>
        )
      )}
    </section>
  );
}
