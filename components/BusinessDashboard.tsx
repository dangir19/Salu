"use client";
import {useEffect,useMemo,useState} from "react";
import type {Page} from "../domain/mock-data";
import {services as demoServices} from "../domain/mock-data";
import {postCredentials} from "./SignIn";

type OrgSummary={
  id:string;name:string;orgType:string;contactName:string;contactEmail:string;
  contactPhone?:string;address?:string;billingEmail?:string;status:string;createdAt:string;
};
type OrgEntry={org:OrgSummary;role:"admin"|"staff";availableCredits:number};
type LineItem={label:string;quantity:number;unitCredits:number;totalCredits:number};
type OrderRow={
  booking:{
    id:string;serviceId:string;serviceName:string;provider:string;date:string;
    mode:string;status:string;credits:number;orgId?:string;recipientName?:string;recipientRoom?:string;
  };
  orderedBy?:string|null;lineItems:LineItem[];
};
type OrderSummary={orderCount:number;creditsSpent:number;creditsRefunded:number};
type Slot={providerId:string;providerName:string;serviceId:string;startISO:string;endISO:string;label:string;mode:string};
type StaffRow={memberId:string;email:string;displayName:string;role:string};

const ORG_TYPES=[["senior_facility","Senior living facility"],["hotel","Hotel"],["corporate","Corporate"],["other","Other"]] as const;
const WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function Eyebrow({children}:{children:React.ReactNode}){
  return <p className="eyebrow">{children}</p>;
}

function isoDay(offset:number){
  const d=new Date();
  d.setDate(d.getDate()+offset);
  return d.toISOString().slice(0,10);
}

async function api<T>(path:string,init?:RequestInit):Promise<T>{
  const res=await fetch(path,{headers:{"Content-Type":"application/json"},...init});
  const data=(await res.json()) as T & {error?:string};
  if(!res.ok) throw new Error(data.error||"Something went wrong.");
  return data;
}

export default function BusinessDashboard({go,signedIn,onSignIn,setToast}:{
  go:(p:Page)=>void;signedIn:boolean;onSignIn:()=>void;setToast:(s:string)=>void;
}){
  const[orgs,setOrgs]=useState<OrgEntry[]|null>(null);
  const[selectedId,setSelectedId]=useState("");
  const[tab,setTab]=useState<"order"|"recurring"|"history"|"staff"|"billing">("order");
  const[notice,setNotice]=useState("");
  const selected=useMemo(()=>orgs?.find(o=>o.org.id===selectedId)??orgs?.[0]??null,[orgs,selectedId]);
  const isAdmin=selected?.role==="admin";

  const refresh=async()=>{
    try{
      const data=await api<{orgs:OrgEntry[]}>("/api/business/me");
      setOrgs(data.orgs);
      setSelectedId(current=>current||data.orgs[0]?.org.id||"");
    }catch{setOrgs([]);}
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{if(signedIn) void refresh();},[signedIn]);

  return <main className="business-page">
    <div className="business-head">
      <div>
        <Eyebrow>SALU FOR BUSINESS</Eyebrow>
        <h1>Wellness for your residents, guests, and team.</h1>
        <p>One dashboard to order services, set weekly schedules, and track spend — billed to your business account.</p>
      </div>
      {signedIn&&selected&&<div className="business-org-picker">
        <label htmlFor="business-org-select">Organization</label>
        <select id="business-org-select" value={selected.org.id} onChange={e=>setSelectedId(e.target.value)}>
          {orgs!.map(o=><option key={o.org.id} value={o.org.id}>{o.org.name} · {o.role}</option>)}
        </select>
      </div>}
    </div>

    {!signedIn&&<BusinessSignup go={go} onSignIn={onSignIn} setToast={setToast} onDone={()=>{}}/>}

    {signedIn&&orgs!==null&&orgs.length===0&&<div className="business-empty">
      <h2>No business account yet.</h2>
      <p>Create your organization below, or ask your organization admin to add your email as staff.</p>
      <BusinessSignup go={go} onSignIn={onSignIn} setToast={setToast} onDone={refresh}/>
    </div>}

    {signedIn&&selected&&<div className="business-dash">
      {selected.org.status!=="active"&&<p className="business-banner">
        {selected.org.status==="pending"
          ?"Your business account is pending approval. Our team reviews every organization — you can explore, but ordering unlocks once approved."
          :`This account is ${selected.org.status}. Contact Salu to reactivate ordering.`}
      </p>}
      <div className="business-tabs" role="tablist">
        {(["order","recurring","history","staff","billing"] as const).map(t=>(
          <button key={t} role="tab" aria-selected={tab===t} className={tab===t?"active":""}
            onClick={()=>setTab(t)} disabled={t!=="order"&&t!=="history"&&!isAdmin}>
            {t==="order"?"Place order":t==="recurring"?"Recurring":t==="history"?"History":t==="staff"?"Staff":"Billing"}
          </button>
        ))}
      </div>
      {notice&&<p className="business-notice">{notice}</p>}
      {tab==="order"&&<OrderTab org={selected} setNotice={setNotice} setToast={setToast} refresh={refresh}/>}
      {tab==="recurring"&&isAdmin&&<RecurringTab org={selected} setNotice={setNotice} setToast={setToast}/>}
      {tab==="history"&&<HistoryTab org={selected}/>}
      {tab==="staff"&&isAdmin&&<StaffTab org={selected} setNotice={setNotice}/>}
      {tab==="billing"&&isAdmin&&<BillingTab org={selected} setNotice={setNotice} refresh={refresh}/>}
    </div>}
  </main>;
}

function BusinessSignup({go,onSignIn,setToast,onDone}:{go:(p:Page)=>void;onSignIn:()=>void;setToast:(s:string)=>void;onDone:()=>void}){
  const[form,setForm]=useState({orgName:"",orgType:"senior_facility",contactName:"",contactEmail:"",contactPhone:"",address:"",billingEmail:"",password:""});
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState("");
  const set=(k:keyof typeof form)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(f=>({...f,[k]:e.target.value}));
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();
    setBusy(true);setError("");
    try{
      await api("/api/business/signup",{method:"POST",body:JSON.stringify({
        orgName:form.orgName,orgType:form.orgType,contactName:form.contactName,
        contactEmail:form.contactEmail,contactPhone:form.contactPhone||undefined,
        address:form.address||undefined,billingEmail:form.billingEmail||undefined,
        password:form.password,
      })});
      setToast(`${form.orgName} is registered — sign-in complete.`);
      onDone();
      await postCredentials({email:form.contactEmail,password:form.password,returnTo:"/business"});
    }catch(err){setError(err instanceof Error?err.message:"Could not create the business account.");setBusy(false);}
  };
  return <section className="business-signup">
    <Eyebrow>CREATE A BUSINESS ACCOUNT</Eyebrow>
    <h2>Bring Salu to your building.</h2>
    <p>Register your facility or company. You become the account admin; our team approves every organization before ordering opens.</p>
    <form onSubmit={submit} className="business-form">
      <label>Organization name<input value={form.orgName} onChange={set("orgName")} required placeholder="Sunrise Senior Living — Brickell"/></label>
      <label>Organization type<select value={form.orgType} onChange={set("orgType")}>
        {ORG_TYPES.map(([v,l])=><option key={v} value={v}>{l}</option>)}
      </select></label>
      <div className="form-row">
        <label>Your name<input value={form.contactName} onChange={set("contactName")} required placeholder="Dana Reyes"/></label>
        <label>Work email<input type="email" value={form.contactEmail} onChange={set("contactEmail")} required placeholder="dana@sunrise.com"/></label>
      </div>
      <div className="form-row">
        <label>Phone<input value={form.contactPhone} onChange={set("contactPhone")} placeholder="(305) 555-0100"/></label>
        <label>Password<input type="password" value={form.password} onChange={set("password")} required minLength={8} placeholder="8+ characters"/></label>
      </div>
      <label>Address<input value={form.address} onChange={set("address")} placeholder="1200 Brickell Bay Dr, Miami, FL"/></label>
      <label>Billing email <span className="optional">(optional — defaults to work email)</span><input type="email" value={form.billingEmail} onChange={set("billingEmail")} placeholder="billing@sunrise.com"/></label>
      {error&&<p className="form-error">{error}</p>}
      <button className="primary-button" disabled={busy}>{busy?"Creating…":"Create business account"}</button>
    </form>
    <p className="business-alt">Already have a Salu account? <button className="link-button" onClick={onSignIn}>Sign in</button> — then ask your admin to add you as staff.</p>
    <p className="business-alt">Looking for personal membership? <button className="link-button" onClick={()=>go("onboard")}>Join as a member</button></p>
  </section>;
}

function useCatalogServices(){
  const[services,setServices]=useState<{id:string;name:string}[]>(demoServices.map(s=>({id:s.id,name:s.name})));
  useEffect(()=>{
    api<{services?:{id:string;name:string}[]}>("/api/providers/catalog")
      .then(d=>{if(d.services?.length) setServices(d.services.map(s=>({id:s.id,name:s.name})));})
      .catch(()=>undefined);
  },[]);
  return services;
}

function OrderTab({org,setNotice,setToast,refresh}:{org:OrgEntry;setNotice:(s:string)=>void;setToast:(s:string)=>void;refresh:()=>void}){
  const services=useCatalogServices();
  const[serviceId,setServiceId]=useState(services[0]?.id??"");
  const[date,setDate]=useState(isoDay(1));
  const[slots,setSlots]=useState<Slot[]|null>(null);
  const[slotStart,setSlotStart]=useState("");
  const[providerId,setProviderId]=useState("auto");
  const[recipientName,setRecipientName]=useState("");
  const[recipientRoom,setRecipientRoom]=useState("");
  const[busy,setBusy]=useState(false);
  const active=org.org.status==="active";
  const providers=useMemo(()=>{
    const map=new Map<string,string>();
    for(const s of slots??[]) map.set(s.providerId,s.providerName);
    return [...map.entries()];
  },[slots]);

  const findTimes=async()=>{
    setNotice("");setSlots(null);setSlotStart("");
    try{
      const to=isoDay(1);
      const data=await api<{slots:Slot[]}>(`/api/providers/slots?serviceId=${encodeURIComponent(serviceId)}&from=${date}T00:00:00-04:00&to=${to}T00:00:00-04:00`);
      setSlots(data.slots);
      if(!data.slots.length) setNotice("No open times that day. Try another date.");
    }catch(err){setNotice(err instanceof Error?err.message:"Could not load times.");}
  };

  const placeOrder=async()=>{
    if(!slotStart){setNotice("Pick a time first.");return;}
    setBusy(true);setNotice("");
    try{
      const data=await api<{booking:{serviceName:string};provider?:{name:string};wallet:{availableCredits:number}}>(
        "/api/business/orders",
        {method:"POST",body:JSON.stringify({
          orgId:org.org.id,serviceId,slotStart,
          providerId:providerId==="auto"?undefined:providerId,
          recipientName:recipientName||undefined,recipientRoom:recipientRoom||undefined,
        })},
      );
      setToast(`Order placed${data.provider?` with ${data.provider.name}`:""} — ${data.wallet.availableCredits} Credits left.`);
      setRecipientName("");setRecipientRoom("");setSlotStart("");setSlots(null);
      void refresh();
    }catch(err){setNotice(err instanceof Error?err.message:"Could not place the order.");}
    setBusy(false);
  };

  return <section>
    <div className="business-balance">Organization wallet: <b>{org.availableCredits.toLocaleString()} Credits</b></div>
    {!active&&<p className="business-banner">Ordering unlocks once your account is approved.</p>}
    <div className="business-form">
      <div className="form-row">
        <label>Service<select value={serviceId} onChange={e=>setServiceId(e.target.value)}>
          {services.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <label>Date<input type="date" value={date} min={isoDay(0)} max={isoDay(14)} onChange={e=>setDate(e.target.value)}/></label>
      </div>
      <button className="primary-button" onClick={findTimes} disabled={!active}>Find times</button>
    </div>
    {slots&&<div className="business-slots">
      <label>Time<select value={slotStart} onChange={e=>setSlotStart(e.target.value)}>
        <option value="">Choose a time…</option>
        {slots.map(s=><option key={s.startISO+s.providerId} value={s.startISO}>{s.label} · {s.providerName}</option>)}
      </select></label>
      <div className="form-row">
        <label>Provider<select value={providerId} onChange={e=>setProviderId(e.target.value)}>
          <option value="auto">Let Salu assign</option>
          {providers.map(([id,name])=><option key={id} value={id}>{name}</option>)}
        </select></label>
      </div>
      <div className="form-row">
        <label>Recipient name <span className="optional">(resident / guest)</span><input value={recipientName} onChange={e=>setRecipientName(e.target.value)} placeholder="Margaret H."/></label>
        <label>Room / unit<input value={recipientRoom} onChange={e=>setRecipientRoom(e.target.value)} placeholder="4B"/></label>
      </div>
      <button className="primary-button" onClick={placeOrder} disabled={busy||!active}>{busy?"Placing…":"Place order"}</button>
    </div>}
  </section>;
}

function RecurringTab({org,setNotice,setToast}:{org:OrgEntry;setNotice:(s:string)=>void;setToast:(s:string)=>void}){
  const services=useCatalogServices();
  const[form,setForm]=useState({serviceId:services[0]?.id??"",weekday:"2",timeLocal:"10:00",startDate:isoDay(1),endDate:isoDay(56),recipientName:"",recipientRoom:""});
  const[busy,setBusy]=useState(false);
  const set=(k:keyof typeof form)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(f=>({...f,[k]:e.target.value}));
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();setBusy(true);setNotice("");
    try{
      const data=await api<{schedule:{id:string};created:unknown[];failed:{date:string;error:string}[]}>(
        "/api/business/recurring",
        {method:"POST",body:JSON.stringify({
          orgId:org.org.id,serviceId:form.serviceId,weekday:Number(form.weekday),timeLocal:form.timeLocal,
          startDate:form.startDate,endDate:form.endDate,
          recipientName:form.recipientName||undefined,recipientRoom:form.recipientRoom||undefined,
        })},
      );
      setToast(`Recurring schedule created — ${data.created.length} sessions booked${data.failed.length?`, ${data.failed.length} could not be placed`:""}.`);
      if(data.failed.length) setNotice(`Could not place: ${data.failed.map(f=>f.date).join(", ")}`);
    }catch(err){setNotice(err instanceof Error?err.message:"Could not create the schedule.");}
    setBusy(false);
  };
  return <section>
    <Eyebrow>WEEKLY SESSIONS</Eyebrow>
    <h2>Standing wellness, handled.</h2>
    <p>Book a repeating weekly session — e.g. chair massage every Tuesday at 10:00 for your residents. We place each occurrence with an available provider.</p>
    <form onSubmit={submit} className="business-form">
      <div className="form-row">
        <label>Service<select value={form.serviceId} onChange={set("serviceId")}>
          {services.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <label>Day<select value={form.weekday} onChange={set("weekday")}>
          {WEEKDAYS.map((d,i)=><option key={d} value={i}>{d}</option>)}
        </select></label>
        <label>Time<input type="time" value={form.timeLocal} onChange={set("timeLocal")} required/></label>
      </div>
      <div className="form-row">
        <label>From<input type="date" value={form.startDate} onChange={set("startDate")} required/></label>
        <label>Through<input type="date" value={form.endDate} onChange={set("endDate")} required/></label>
      </div>
      <div className="form-row">
        <label>Recipient <span className="optional">(optional)</span><input value={form.recipientName} onChange={set("recipientName")} placeholder="Margaret H."/></label>
        <label>Room / unit<input value={form.recipientRoom} onChange={set("recipientRoom")} placeholder="4B"/></label>
      </div>
      <button className="primary-button" disabled={busy}>{busy?"Booking sessions…":"Create weekly schedule"}</button>
    </form>
  </section>;
}

function HistoryTab({org}:{org:OrgEntry}){
  const[orders,setOrders]=useState<OrderRow[]|null>(null);
  const[summary,setSummary]=useState<OrderSummary|null>(null);
  useEffect(()=>{
    api<{orders:OrderRow[];summary:OrderSummary}>(`/api/business/orders?orgId=${org.org.id}`)
      .then(d=>{setOrders(d.orders);setSummary(d.summary);})
      .catch(()=>setOrders([]));
  },[org.org.id]);
  if(orders===null) return <p>Loading order history…</p>;
  return <section>
    {summary&&<div className="business-stats">
      <div><b>{summary.orderCount}</b><span>orders</span></div>
      <div><b>{summary.creditsSpent.toLocaleString()}</b><span>Credits spent</span></div>
      <div><b>{summary.creditsRefunded.toLocaleString()}</b><span>refunded</span></div>
    </div>}
    {orders.length===0?<p>No orders yet. Place your first order above.</p>:
    <table className="business-table">
      <thead><tr><th>Date</th><th>Service</th><th>Recipient</th><th>Provider</th><th>Status</th><th>Credits</th></tr></thead>
      <tbody>{orders.map(o=><tr key={o.booking.id}>
        <td>{o.booking.date}</td><td>{o.booking.serviceName}</td>
        <td>{o.booking.recipientName??"—"}{o.booking.recipientRoom?` · ${o.booking.recipientRoom}`:""}</td>
        <td>{o.booking.provider||"Unassigned"}</td><td>{o.booking.status}</td><td>{o.booking.credits}</td>
      </tr>)}</tbody>
    </table>}
  </section>;
}

function StaffTab({org,setNotice}:{org:OrgEntry;setNotice:(s:string)=>void}){
  const[staff,setStaff]=useState<StaffRow[]|null>(null);
  const[email,setEmail]=useState("");
  const[busy,setBusy]=useState(false);
  const load=()=>api<{staff:StaffRow[]}>(`/api/business/staff?orgId=${org.org.id}`).then(d=>setStaff(d.staff)).catch(()=>setStaff([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[org.org.id]);
  const add=async(e:React.FormEvent)=>{
    e.preventDefault();setBusy(true);setNotice("");
    try{
      await api("/api/business/staff",{method:"POST",body:JSON.stringify({orgId:org.org.id,email})});
      setEmail("");setNotice(`${email} added as staff.`);
      void load();
    }catch(err){setNotice(err instanceof Error?err.message:"Could not add staff.");}
    setBusy(false);
  };
  return <section>
    <Eyebrow>TEAM</Eyebrow>
    <h2>Who can order for {org.org.name}.</h2>
    <p>Staff can place orders. Admins can also manage staff and billing.</p>
    <form onSubmit={add} className="business-form inline-form">
      <label>Staff email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="teammate@sunrise.com"/></label>
      <button className="primary-button" disabled={busy}>{busy?"Adding…":"Add staff"}</button>
    </form>
    {staff===null?<p>Loading…</p>:<table className="business-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
      <tbody>{staff.map(s=><tr key={s.memberId}><td>{s.displayName}</td><td>{s.email}</td><td>{s.role}</td></tr>)}</tbody>
    </table>}
  </section>;
}

function BillingTab({org,setNotice,refresh}:{org:OrgEntry;setNotice:(s:string)=>void;refresh:()=>void}){
  const[busy,setBusy]=useState<number|null>(null);
  const topUp=async(credits:number)=>{
    setBusy(credits);setNotice("");
    try{
      const data=await api<{url?:string;applied?:boolean;wallet?:{availableCredits:number};message?:string}>(
        "/api/business/credits",{method:"POST",body:JSON.stringify({orgId:org.org.id,credits})});
      if(data.url){window.location.assign(data.url);return;}
      setNotice(data.message??`Added ${credits} Credits to the organization wallet.`);
      void refresh();
    }catch(err){setNotice(err instanceof Error?err.message:"Could not start checkout.");}
    setBusy(null);
  };
  return <section>
    <Eyebrow>BILLING</Eyebrow>
    <h2>One wallet for the whole organization.</h2>
    <p>Every order draws from the organization wallet. Top up with a card on file via Stripe; every order stores line items so net-terms invoicing can follow later.</p>
    <div className="business-balance big">Available: <b>{org.availableCredits.toLocaleString()} Credits</b></div>
    <div className="topup-row">
      {[100,200,500].map(c=><button key={c} className="primary-button" disabled={busy!==null} onClick={()=>void topUp(c)}>
        {busy===c?"Starting…":`Add ${c} Credits`}
      </button>)}
    </div>
  </section>;
}
