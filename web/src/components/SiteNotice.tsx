import notice from "../../public/site-notice.html?raw";

/** One trusted, static notice shared with the server-rendered public reference. */
export function SiteNotice() {
  return <div dangerouslySetInnerHTML={{ __html: notice }} />;
}
