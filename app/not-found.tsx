import Link from "next/link";

export default function NotFound(){
 return <main className="member-page">
  <div className="empty">
   <span className="atlas-mark" aria-hidden="true">A</span>
   <h1>This page isn’t on the map.</h1>
   <p>That link doesn’t match a Salu surface. Head home to ask Atlas or explore Miami.</p>
   <Link className="primary-button" href="/">Back to Salu</Link>
  </div>
 </main>;
}
