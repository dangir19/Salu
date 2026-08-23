"use client";

import Link from "next/link";
import {useEffect, useState} from "react";
import type {AuthSurface} from "../auth/env";
import type {MemberSession} from "../auth/identity";
import type {Page} from "../domain/mock-data";
import type {ProviderAccount} from "../domain/types";
import {ProviderSignIn} from "./SignIn";

type WorkspaceTab = "requests" | "schedule";
type UiRequest = {
  id: string;
  bookingId: string;
  memberDisplayName: string;
  serviceName: string;
  practiceName: string;
  date: string;
  mode: string;
  creditsCharged: number;
  status: "open" | "accepted" | "declined" | "proposed" | "cancelled";
  proposedDate?: string;
  note?: string;
  walkthrough?: boolean;
};
type UiBlock = {id: string; date: string; note?: string};
type InboxSnapshot = {
  source: "demo" | "server";
  provider?: ProviderAccount | null;
  requests?: UiRequest[];
  jobs?: UiRequest[];
  blocks?: UiBlock[];
  error?: string;
  message?: string;
};

const PROPOSE_TIMES = ["Friday · 6:30 PM", "Friday · 8:00 PM", "Saturday · 10:00 AM"];
const BLOCK_TIMES = ["Today · 4:00 PM", "Tomorrow · 6:00 PM", "Friday · 6:30 PM", "Saturday · 11:00 AM"];

function Eyebrow({children}:{children:React.ReactNode}) {
  return <span className="eyebrow">{children}</span>;
}

function PageHead({eyebrow, title, copy}:{eyebrow:string;title:string;copy?:string}) {
  return (
    <div className="page-head">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        {copy && <p>{copy}</p>}
      </div>
    </div>
  );
}

function DemoPortal({go}:{go:(p:Page)=>void}) {
  return (
    <PortalFrame
      go={go}
      signedIn={false}
      practice="Tide & Tone Recovery"
      tab="requests"
      setTab={() => undefined}
    >
      <PageHead
        eyebrow="TIDE & TONE RECOVERY · FABRICATED DEMO"
        title="Today at a glance"
        copy="Labeled demo · sign in as a provider to fill live appointment requests."
      />
      <p className="provider-live-banner">
        This glance is fabricated prototype data. Sign in to accept a live member booking from the in-app queue.
      </p>
      <div className="portal-metrics">
        {[["3","Arrivals today"],["28","Completed this month"],["$4,620","Gross member spend"],["$3,696","Estimated payout"]].map((x) => (
          <article key={x[1]}><strong>{x[0]}</strong><span>{x[1]}</span></article>
        ))}
      </div>
      <section className="portal-card">
        <div className="section-title">
          <Eyebrow>UPCOMING · DEMO DATA</Eyebrow>
          <h2>Member reservations.</h2>
        </div>
        {[["6:00 PM","Deep Tissue Massage","Brickell · At home","$96 payout"],["7:30 PM","Sports Massage","Miami Beach · At home","$96 payout"],["SAT 11:00","Runner Pack Redemption","Coral Gables","$118 payout"]].map((row) => (
          <div className="portal-row" key={row[0]}>
            {row.map((cell) => <span key={cell}>{cell}</span>)}
            <span className="status-pill">Confirmed</span>
          </div>
        ))}
      </section>
      <section className="portal-card economics">
        <div className="section-title">
          <Eyebrow>SERVICE ECONOMICS</Eyebrow>
          <h2>Sports Massage.</h2>
        </div>
        <div>
          {[["Standard price","$150"],["Gold price · 10% off","$135"],["Platinum price · 20% off","$120"],["Salu commission","20%"],["Platinum payout","$96"]].map((x) => (
            <span key={x[0]}><small>{x[0]}</small><b>{x[1]}</b></span>
          ))}
        </div>
        <p>Platinum example: $120 member price − $24 commission = $96 provider payout. Package redemptions and credentials are fabricated prototype data. Stripe Connect is not in this workspace.</p>
      </section>
      <div className="provider-signin-cta">
        <Link className="primary-button" href="/provider/signin">Provider sign-in</Link>
      </div>
    </PortalFrame>
  );
}

function PortalFrame({
  go,
  signedIn,
  practice,
  tab,
  setTab,
  onSignOut,
  children,
}:{
  go:(p:Page)=>void;
  signedIn:boolean;
  practice:string;
  tab:WorkspaceTab;
  setTab:(tab:WorkspaceTab)=>void;
  onSignOut?:()=>void;
  children:React.ReactNode;
}) {
  return (
    <main className="portal-shell">
      <aside>
        <button className="wordmark" aria-label="Return to Salu member home" onClick={() => go("home")}>salu<span>°</span></button>
        <small>{signedIn ? `${practice} · live queue` : "Provider workspace · demo"}</small>
        {signedIn ? (
          <>
            <button type="button" className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>Requests</button>
            <button type="button" className={tab === "schedule" ? "active" : ""} onClick={() => setTab("schedule")}>Schedule</button>
            <span className="portal-nav unavailable">Finance<small>Demo only · Connect later</small></span>
            <span className="portal-nav unavailable">Settings<small>Demo only</small></span>
          </>
        ) : (
          <>
            <span className="portal-nav active">Overview</span>
            {["Appointments","Services","Availability","Finance","Settings"].map((item) => (
              <span className="portal-nav unavailable" key={item}>{item}<small>Demo only</small></span>
            ))}
          </>
        )}
        {onSignOut && <button type="button" className="back-member" onClick={onSignOut}>Sign out</button>}
        <button className="back-member" onClick={() => go("home")}>← Member experience</button>
      </aside>
      <section>{children}</section>
    </main>
  );
}

export default function ProviderWorkspace({
  go,
  provider,
  surface,
  signOut,
}:{
  go:(p:Page)=>void;
  session?: MemberSession | null;
  provider: ProviderAccount | null;
  surface: AuthSurface;
  signOut:()=>void;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("requests");
  const [requests, setRequests] = useState<UiRequest[]>([]);
  const [jobs, setJobs] = useState<UiRequest[]>([]);
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [busyId, setBusyId] = useState("");
  const [toast, setToast] = useState("");
  const [proposeFor, setProposeFor] = useState("");
  const [proposeDate, setProposeDate] = useState(PROPOSE_TIMES[0]);
  const [blockDate, setBlockDate] = useState(BLOCK_TIMES[0]);
  const [source, setSource] = useState<"demo" | "server">(provider ? "server" : "demo");

  const refresh = () => {
    if (!provider) return;
    Promise.all([
      fetch("/api/provider/requests").then((res) => res.json()) as Promise<InboxSnapshot>,
      fetch("/api/provider/schedule").then((res) => res.json()) as Promise<InboxSnapshot>,
    ]).then(([inbox, schedule]) => {
      if (inbox.source === "server" && Array.isArray(inbox.requests)) {
        setSource("server");
        setRequests(inbox.requests);
      }
      if (schedule.source === "server") {
        if (Array.isArray(schedule.jobs)) setJobs(schedule.jobs);
        if (Array.isArray(schedule.blocks)) setBlocks(schedule.blocks);
      }
      if (inbox.error) setToast(inbox.error);
    }).catch(() => undefined);
  };

  // Poll the live queue while this provider session is open.
  useEffect(() => {
    if (!provider) return;
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over the latest setters.
  }, [provider]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const act = async (path: string, body: Record<string, string>, id: string, ok: string) => {
    setBusyId(id);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
      });
      const data = await res.json() as InboxSnapshot;
      if (Array.isArray(data.requests)) setRequests(data.requests);
      if (Array.isArray(data.jobs)) setJobs(data.jobs);
      if (Array.isArray(data.blocks)) setBlocks(data.blocks);
      if (data.error && res.status !== 401) {
        setToast(data.error);
        return;
      }
      setToast(ok);
      setProposeFor("");
      refresh();
    } catch {
      setToast("The queue could not update just now.");
    } finally {
      setBusyId("");
    }
  };

  if (!provider) {
    if (typeof window !== "undefined" && window.location.pathname === "/provider/signin") {
      return <ProviderSignIn surface={surface} returnTo="/provider" />;
    }
    return <DemoPortal go={go} />;
  }

  const openRequests = requests.filter((row) => row.status === "open" || row.status === "proposed");

  return (
    <PortalFrame
      go={go}
      signedIn
      practice={provider.practiceName}
      tab={tab}
      setTab={setTab}
      onSignOut={signOut}
    >
      {toast && <p className="provider-toast" role="status">{toast}</p>}
      {tab === "requests" && (
        <>
          <PageHead
            eyebrow={`${provider.practiceName.toUpperCase()} · ${source === "server" ? "LIVE QUEUE" : "DEMO"}`}
            title="Incoming requests"
            copy="Member bookings that need a provider land here. Accept, decline, or propose a new time. The queue refreshes every few seconds."
          />
          <div className="portal-metrics">
            <article><strong>{openRequests.length}</strong><span>Open requests</span></article>
            <article><strong>{jobs.filter((job) => job.status === "accepted").length}</strong><span>Accepted jobs</span></article>
            <article><strong>{blocks.length}</strong><span>Blocked times</span></article>
            <article><strong>—</strong><span>Payouts · Connect later</span></article>
          </div>
          <section className="portal-card">
            <div className="section-title">
              <Eyebrow>IN-APP QUEUE</Eyebrow>
              <h2>Fill the next visit.</h2>
            </div>
            {openRequests.length ? openRequests.map((request) => (
              <article className="request-card" key={request.id}>
                <div>
                  <small>{request.date}{request.walkthrough ? " · labeled walkthrough" : ""}</small>
                  <h3>{request.serviceName}</h3>
                  <p>{request.memberDisplayName} · {request.mode}</p>
                  {request.note && <p className="request-note">{request.note}</p>}
                  {request.status === "proposed" && request.proposedDate && (
                    <p className="request-note">You proposed {request.proposedDate}. Waiting on the member calendar.</p>
                  )}
                </div>
                <div className="request-actions">
                  <button type="button" disabled={busyId === request.id} onClick={() => void act("/api/provider/requests/accept", {id: request.id}, request.id, `${request.serviceName} is on your calendar.`)}>Accept</button>
                  <button type="button" disabled={busyId === request.id} onClick={() => void act("/api/provider/requests/decline", {id: request.id}, request.id, "Request declined.")}>Decline</button>
                  <button type="button" disabled={busyId === request.id} onClick={() => {setProposeFor(request.id); setProposeDate(PROPOSE_TIMES[0]);}}>Propose new time</button>
                </div>
                {proposeFor === request.id && (
                  <form
                    className="propose-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void act("/api/provider/requests/propose", {id: request.id, date: proposeDate}, request.id, `Proposed ${proposeDate}.`);
                    }}
                  >
                    <label>
                      Proposed time
                      <select value={proposeDate} onChange={(event) => setProposeDate(event.target.value)}>
                        {PROPOSE_TIMES.map((time) => <option key={time}>{time}</option>)}
                      </select>
                    </label>
                    <button type="submit" disabled={busyId === request.id}>Send proposal</button>
                  </form>
                )}
              </article>
            )) : (
              <p className="request-empty">No incoming requests. When a member books {provider.practiceName}, it appears here.</p>
            )}
          </section>
        </>
      )}
      {tab === "schedule" && (
        <>
          <PageHead
            eyebrow={`${provider.practiceName.toUpperCase()} · CALENDAR`}
            title="Your week"
            copy="Accepted jobs and times you have blocked. Stripe Connect payouts stay out of this view."
          />
          <section className="portal-card">
            <div className="section-title">
              <Eyebrow>ACCEPTED JOBS</Eyebrow>
              <h2>Upcoming visits.</h2>
            </div>
            {jobs.filter((job) => job.status === "accepted").length ? jobs.filter((job) => job.status === "accepted").map((job) => (
              <div className="request-card" key={job.id}>
                <div>
                  <small>{job.date}</small>
                  <h3>{job.serviceName}</h3>
                  <p>{job.memberDisplayName} · {job.mode}</p>
                </div>
                <span className="status-pill">Accepted</span>
              </div>
            )) : <p className="request-empty">No accepted jobs yet. Take one from the request queue.</p>}
          </section>
          <section className="portal-card">
            <div className="section-title">
              <Eyebrow>BLOCKED TIME</Eyebrow>
              <h2>Keep the calendar honest.</h2>
            </div>
            <form
              className="propose-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act("/api/provider/schedule/block", {date: blockDate, note: "Provider blocked time"}, `block-${blockDate}`, `${blockDate} is blocked.`);
              }}
            >
              <label>
                Block off
                <select value={blockDate} onChange={(event) => setBlockDate(event.target.value)}>
                  {BLOCK_TIMES.map((time) => <option key={time}>{time}</option>)}
                </select>
              </label>
              <button type="submit" disabled={Boolean(busyId)}>Block this time</button>
            </form>
            {blocks.map((block) => (
              <div className="request-card" key={block.id}>
                <div>
                  <small>Blocked</small>
                  <h3>{block.date}</h3>
                  {block.note && <p>{block.note}</p>}
                </div>
                <button type="button" disabled={busyId === block.id} onClick={() => void act("/api/provider/schedule/unblock", {id: block.id}, block.id, "Time is open again.")}>Remove block</button>
              </div>
            ))}
          </section>
        </>
      )}
    </PortalFrame>
  );
}
