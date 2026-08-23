import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const app=await readFile(new URL("../components/SaluApp.tsx",import.meta.url),"utf8");
const data=await readFile(new URL("../domain/mock-data.ts",import.meta.url),"utf8");
const types=await readFile(new URL("../domain/types.ts",import.meta.url),"utf8");
const payments=await readFile(new URL("../domain/payments.ts",import.meta.url),"utf8");
const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
const networkCss=await readFile(new URL("../app/network.css",import.meta.url),"utf8");
const membershipCss=await readFile(new URL("../app/membership.css",import.meta.url),"utf8");
const legacyPlanCss=await Promise.all(["extended2.css","audit2.css","responsive.css","network.css"].map(name=>readFile(new URL(`../app/${name}`,import.meta.url),"utf8"))).then(parts=>parts.join("\n"));
const layout=await readFile(new URL("../app/layout.tsx",import.meta.url),"utf8");
const routes=await readFile(new URL("../domain/routes.ts",import.meta.url),"utf8");
const notFound=await readFile(new URL("../app/not-found.tsx",import.meta.url),"utf8");
const catchAll=await readFile(new URL("../app/[[...slug]]/page.tsx",import.meta.url),"utf8");

test("keeps Atlas primary while preserving marketplace discovery",()=>{
 assert.match(app,/THE SALU NETWORK/);
 assert.match(app,/Premium, vetted in-home wellness brought to your door/);
 assert.doesNotMatch(app,/Service setting|Any setting/);
 assert.match(app,/rankedServiceIds\.map\(id=>services\.find\(s=>s\.id===id\)\)/);
 assert.match(app,/className="atlas-fab"/);
 assert.match(app,/className="atlas-hero"/);
 assert.match(app,/onClick=\{\(\)=>go\("home"\)\}>Home<\/button>/);
 assert.match(app,/go\("bookings"\)\}>Appointments<\/button>/);
 assert.match(app,/YOUR APPOINTMENTS/);
 assert.doesNotMatch(app,/>Bookings<\/button>/);
 assert.match(app,/Explore Miami/);
 assert.match(app,/Search services/);
 assert.match(css,/\.quiet-links button\{[^}]*min-height:44px[^}]*font-size:15px[^}]*font-weight:750/);
 assert.match(app,/Personal care at your doorstep\./);
 assert.doesNotMatch(app,/Personal care<br\/>at your doorstep\./);
 assert.doesNotMatch(app,/Care, brought<br\/>to your door\./);
 assert.match(app,/Choose your in-home wellness activity today/);
 assert.doesNotMatch(app,/Choose your in-home wellness today/);
});
test("supports booking, credits, packages and local demo persistence",()=>{
 for(const term of ["confirmBooking","setCredits","setBookings","purchasePackage","localStorage","PackageProduct"]){assert.match(app,new RegExp(term))}
});
test("covers required services and safety boundaries",()=>{
 for(const term of ["sports massage","Blood tests","IV drip","NAD\\+ drip","Acupuncture","Lymphatic drainage massage","Facial workout massage","Dermatology consultation","sleep-test","does not process insurance","call 911"]){assert.match(app+data,new RegExp(term,"i"))}
});
test("models marketplace economics and separate entitlements",()=>{
 for(const term of ["Gross marketplace volume","Salu net revenue","Provider payouts","Package liabilities","PlatformCommission","PackageEntitlement"]){assert.match(app+types,new RegExp(term))}
});
test("keeps wallet math and pricing rules explicit",()=>{
 for(const term of ["1 Credit equals $1","initialTransactions","setTransactions","Refund ·","Current balance","Salu Platinum monthly contribution","Credits roll automatically","Credits are never lost"]){assert.match(app,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
 assert.match(app,/setCredits\(v=>v\+booking\.credits\)/);
 assert.match(app,/planDiscount:Record<PlanName,number>=\{Member:0,Gold:\.1,Platinum:\.2\}/);
 assert.match(app,/Math\.round\(price\*\(1-planDiscount\[plan\]\)\)/);
});
test("labels prototype-only portal controls instead of shipping fake buttons",()=>{
 assert.match(app,/portal-nav unavailable/);
 assert.match(app,/Demo only/);
 assert.match(app,/status-pill/);
 assert.doesNotMatch(app,/<button>View<\/button>/);
});
test("removes the dedicated Travel Mode experience",()=>{
 assert.doesNotMatch(app,/Travel Mode|go\("travel"\)|page==="travel"|function Travel/);
 assert.doesNotMatch(data,/"travel"\|"apps"/);
});
test("offers the new plans and combines plans with packages",()=>{
 for(const term of ["Plans & Packages","Free membership","200 monthly Salu Credits","500 monthly Salu Credits","10% off services and packages","20% off services and packages"]){assert.match(app,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
for(const name of ["Member","Gold","Platinum"]){assert.match(types,new RegExp(`\\"${name}\\"`))}
 for(const term of ["membership-plans-grid","membership-plan-card","plan-gold","plan-platinum","membership-plan-button"]){assert.match(app+membershipCss,new RegExp(term))}
 assert.match(membershipCss,/plan-gold[\s\S]*?--plan-button:#9b702f[\s\S]*?--plan-button-text:#fff/);
 assert.match(membershipCss,/plan-platinum[\s\S]*?--plan-button:#fff[\s\S]*?--plan-button-text:#173b33/);
 assert.doesNotMatch(legacyPlanCss,/plans-grid|platinum-plan|current-plan/);
});
test("builds every curated routine only from the ten currently offered services",()=>{
 const packageData=data.slice(data.indexOf("export const packages"),data.indexOf("export const initialBookings"));
 const offered=["Deep Tissue Massage","Sports Massage","Lymphatic Drainage Massage","Blood Tests","Facial","Assisted Stretching","Facial Workout Massage","IV Drip","Acupuncture","NAD+ Drip"];
 const packageServices=[...packageData.matchAll(/label:"([^"]+)"/g)].map(match=>match[1]);
 for(const service of packageServices){assert.ok(offered.includes(service),`${service} is not one of the ten currently offered services`)}
 const runnerData=packageData.slice(packageData.indexOf('name:"Runner Recovery Pack"'),packageData.indexOf('name:"Salu Essentials Pack"'));
 assert.match(runnerData,/price:800[\s\S]*?label:"Sports Massage",count:4[\s\S]*?label:"Assisted Stretching",count:2/);
 assert.doesNotMatch(runnerData,/Acupuncture/);
 const essentialsData=packageData.slice(packageData.indexOf('name:"Salu Essentials Pack"'),packageData.indexOf('name:"Looking Snatched Pack"'));
 assert.match(essentialsData,/price:900[\s\S]*?label:"Deep Tissue Massage",count:2[\s\S]*?label:"Lymphatic Drainage Massage",count:2[\s\S]*?label:"Acupuncture",count:2/);
 assert.doesNotMatch(packageData,/Full Body Reset Pack/);
 const lookingSnatchedData=packageData.slice(packageData.indexOf('name:"Looking Snatched Pack"'),packageData.indexOf('name:"GLP-1 Journey Pack"'));
 assert.match(lookingSnatchedData,/price:400[\s\S]*?label:"Facial",count:1[\s\S]*?label:"Facial Workout Massage",count:1[\s\S]*?label:"Lymphatic Drainage Massage",count:1/);
 assert.doesNotMatch(packageData,/Event Ready Pack|Look Your Best Pack/);
 const glpData=packageData.slice(packageData.indexOf('name:"GLP-1 Journey Pack"'));
 assert.match(glpData,/price:900[\s\S]*?label:"Blood Tests",count:4[\s\S]*?label:"Lymphatic Drainage Massage",count:2[\s\S]*?label:"Facial Workout Massage",count:2/);
 assert.doesNotMatch(packageData,/Clinical Access Pack/);
 for(const oldItem of ["PT Assessment","Dietitian Consultation","Nutrition Follow-Ups","Body-Composition Appointments","Strength Sessions","Recovery Studio","Virtual Wellness Consultation","Teeth Whitening","Private Training","Clinician Consultation"]){assert.ok(!packageData.includes(oldItem),`${oldItem} is not currently offered`)}
 for(const name of ["Runner Recovery Pack","Salu Essentials Pack","Looking Snatched Pack","GLP-1 Journey Pack"]){assert.ok(packageData.includes(name))}
 assert.match(app,/salu-demo-state-v6/);
});
test("keeps the Home Atlas prompt in place until submit",()=>{
 assert.match(app,/form className="atlas-hero" onSubmit=\{submitAtlas\}/);
 assert.match(app,/How can I help you feel your best\?/);
 assert.match(app,/Ask Atlas\. Make a plan\. Be cared for\./);
 assert.match(app,/Help me plan my marathon training plan recovery/);
 assert.match(app,/Get me a Deep Tissue Massage in the next hour/);
 assert.match(app,/if\(prompt\)startAtlas\(prompt\)/);
 assert.match(app,/initialPrompt/);
 assert.doesNotMatch(app,/className="member-strip"/);
});
test("uses at-home recommendation artwork and concise service names",()=>{
 assert.match(data,/name:"Sports Massage"[\s\S]*?mode:"At home"/);
 assert.match(data,/name:"Deep Tissue Massage"[\s\S]*?mode:"At home"/);
 assert.match(data,/name:"Assisted Stretching"[\s\S]*?mode:"At home"/);
 assert.doesNotMatch(data,/name:"In-home (?:sports|relaxation) massage"/);
 assert.match(css,/recommendations\/sports-massage\.jpg/);
 assert.match(css,/recommendations\/deep-tissue-massage\.jpg/);
 assert.match(css,/recommendations\/assisted-stretching\.jpg/);
 assert.match(app,/rankedServiceIds/);
 assert.match(app,/Show previous recommendations/);
 assert.match(app,/Show more recommendations/);
 assert.match(app,/scrollBy/);
 assert.match(app,/In-home wellness,/);
for(const image of ["blood-tests","iv-drip","nad-drip"]){assert.match(css,new RegExp(`recommendations/${image}\\.jpg`))}
for(const image of ["acupuncture","lymphatic-massage","facial-workout-massage"]){assert.match(css,new RegExp(`recommendations/${image}\\.jpg`))}
});
test("uses title case for service names globally",()=>{
 for(const name of ["Sports Massage","Deep Tissue Massage","Assisted Stretching","Blood Tests","Registered Dietitian Consultation","Private Personal Training","Physical Therapy Assessment","Teeth Whitening Appointment","IV Drip","NAD+ Drip","Lymphatic Drainage Massage","Facial Workout Massage","DEXA Body-Composition Appointment","Recovery Studio Circuit","Dermatology Consultation","Concierge Primary-Care House Call","At-Home Sleep-Test Setup"]){assert.match(data,new RegExp(`name:"${name.replace(/[+]/g,"\\+")}"`))}
 assert.match(app,/provider\.focuses\.map\(titleCaseService\)/);
 const runnerEntitlement=app.slice(app.indexOf('const initialEntitlements'),app.indexOf('const planCredits'));
 assert.match(runnerEntitlement,/Sports Massage[\s\S]*?remaining:3,total:4[\s\S]*?Assisted Stretching[\s\S]*?remaining:2,total:2/);
 assert.doesNotMatch(runnerEntitlement,/Acupuncture/);
 assert.doesNotMatch(data,/name:"(?:Sports massage|Deep tissue massage|Assisted stretching|Blood tests|IV drip|NAD\+ drip)"/);
});
test("makes services horizontal and providers the vertical network focus",()=>{
 assert.match(data,/export const topProviders:ProviderProfile\[]/);
 assert.equal((data.match(/funFact:"/g)||[]).length,20);
 assert.equal((data.match(/years:\d+/g)||[]).length,20);
 for(const term of ["service-menu-rail","Show more services","provider-list","provider-card","provider-photo","Our Expert Network","FOCUSES","FUN FACT","years of experience"]){assert.match(app,new RegExp(term))}
 assert.match(networkCss,/provider-list\{display:flex;flex-direction:column/);
 assert.match(networkCss,/service-menu-rail\{display:flex/);
 assert.doesNotMatch(app,/provider\.rating|provider\.reviews|★|MEMBER FAVORITES/);
 assert.doesNotMatch(app,/#\{String\(index\+1\)/);
});
test("groups Explore services into the requested categories",()=>{
 assert.match(app,/\["All","Recovery","Aesthetic","Clinical"\]/);
 assert.match(app,/category==="Recovery"\?"Recover today and prepare for tomorrow"/);
 assert.match(app,/category==="Aesthetic"\?"Be ready for your next event"/);
 assert.match(app,/category==="Clinical"\?"Bring the lab to your home"/);
 assert.match(data,/id:"lymphatic-massage"[\s\S]*?category:"Aesthetic"/);
 assert.match(data,/id:"facial-workout"[\s\S]*?category:"Aesthetic"/);
 assert.match(data,/id:"acupuncture"[\s\S]*?category:"Recovery"/);
 assert.match(data,/id:"blood-draw"[\s\S]*?category:"Clinical"/);
 assert.match(data,/id:"iv"[\s\S]*?category:"Clinical"/);
 assert.match(data,/id:"nad"[\s\S]*?category:"Clinical"/);
 assert.match(app,/rankedServiceIds=\["deep-tissue","sports-massage","lymphatic-massage","blood-draw","facial","stretch","facial-workout","iv","acupuncture","nad"\]/);
 assert.match(data,/id:"facial"[\s\S]*?name:"Facial"[\s\S]*?category:"Aesthetic"[\s\S]*?mode:"At home"/);
 assert.doesNotMatch(data,/Signature facial/);
});
test("gives every provider functional schedule and Atlas chat actions",()=>{
 for(const term of ["provider-actions","Schedule with","Chat with Atlas about","startAtlas(`I’d like to chat about booking with"]){assert.match(app,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
 assert.doesNotMatch(app,/View & book/);
 assert.match(networkCss,/provider-actions\{display:grid;grid-template-columns:1fr 1fr/);
});
test("shows standard prices before plan discounts and charges discounted Credits",()=>{
 const expected={"deep-tissue":150,"sports-massage":150,"lymphatic-massage":150,"blood-draw":100,"facial":150,"stretch":100,"facial-workout":100,"iv":125,"acupuncture":150,"nad":300};
 for(const [id,price] of Object.entries(expected)){assert.match(data,new RegExp(`id:"${id}"[\\s\\S]*?price:${price},standardPrice:${price}`))}
 for(const term of ["$${s.standardPrice} standard","Credits with","STANDARD PRICE","checkout charges ${charge} Credits"]){assert.match(app,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
 assert.match(app,/packPrice=Math\.round\(p\.price\*\.9\)/);
 assert.match(app,/<s>\{p\.price\.toLocaleString\(\)\} Credits<\/s>[\s\S]*?10% pack savings[\s\S]*?additional \$\{discount\}% off/);
 assert.match(app,/Wellness coordination only[\s\S]*?Salu does not prescribe or manage GLP-1 medication/);
 assert.doesNotMatch(app,/<span>\{s\.mode\}<\/span>/);
});
test("keeps a single-member profile and adds About after plans",()=>{
 assert.ok(app.indexOf(">Appointments</button>")<app.indexOf(">Plans &amp; Packages</button>"));
 assert.ok(app.indexOf(">Plans &amp; Packages</button>")<app.indexOf(">About</button>"));
 for(const term of ["ABOUT SALU","Your health","concierge","WHY WE FOUNDED SALU","We founded Salu for health-conscious members","comfort of home","premium network of vetted, experienced talent","best care at home","on-demand, premium service","members&apos; time, comfort and care","Thoughtful in-home services, coordinated from one place","Community of experts vetted by Salu"]){assert.match(app,new RegExp(term))}
 assert.doesNotMatch(app,/coordinated from one calm place/);
 assert.doesNotMatch(app,/Independent experts presented clearly, without rankings or pressure/);
 assert.doesNotMatch(app,/About Us/);
 for(const term of ["principle-icon icon-person","principle-icon icon-breeze","principle-icon icon-community","Community of experts vetted by Salu"]){assert.match(app,new RegExp(term))}
 assert.match(app,/packages built around your lifestyle - unlocking additional discounts/);
 assert.doesNotMatch(app,/health best friend|best friend\./i);
 assert.doesNotMatch(app,/getting back in a car after a massage/);
 assert.doesNotMatch(app,/OUR ROLE|Hospitality and coordination|about-boundary/);
 for(const term of ["eyebrow=\"PROFILE\" title={displayName}","Your Salu membership","Brickell, Miami","1451 Brickell Avenue","MEMBER SINCE","Sports Recovery · Relaxation","ACTIVITIES","Running · Biking","BILLING","No payment method on file","Stripe Billing is not connected yet","PAYMENT_PLACEHOLDER"]){assert.match(app+payments,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
 assert.doesNotMatch(app,/Visa •••• 4242|Card on file · Expires 08\/29|simulated demo account/);
 for(const term of ["profile-preference-card","preference-edit","beginEdit","savePreference","setPreferences","Edit ${item.label.toLowerCase()}","Cancel","Save"]){assert.match(app,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
 assert.doesNotMatch(app,/Create demo invite|ONE SPOT OPEN|Add a profile|Household profiles|>Household<|PREFERRED SETTING/);
});
test("uses joinsalu.com metadata and a branded social preview",()=>{
 for(const term of ["https://joinsalu.com","Your health concierge","openGraph","summary_large_image","/og.png","In-home wellness, beautifully handled."]){assert.match(layout,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
 assert.doesNotMatch(layout,/Your health best friend/);
});
test("exposes shareable member routes and a branded unknown-page state",()=>{
 for(const path of ["/atlas","/explore","/appointments","/plans","/about","/credits","/profile","/join","/apply","/provider","/admin","/signin"]){assert.match(routes,new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")))}
 assert.match(app,/history\.pushState/);
 assert.match(app,/popstate/);
 assert.match(app,/pageFromPath/);
 assert.match(catchAll,/generateStaticParams/);
 assert.match(catchAll,/notFound\(\)/);
 assert.match(notFound,/This page isn’t on the map/);
 assert.match(notFound,/Back to Salu/);
 assert.match(notFound,/from "next\/link"/);
});
test("uses package sessions before charging Credits and labels demo billing",()=>{
 assert.match(app,/confirmed using a \$\{pack\.name\} session/);
 assert.match(app,/packageName&&booking\.packageItem/);
 assert.match(app,/setCredits\(v=>v\+booking\.credits\)/);
 assert.match(app,/Stripe Billing is not connected yet/);
 assert.match(app,/Your Salu membership/);
 assert.match(app,/complete\(name\.trim\(\),home\.trim\(\)\)/);
 assert.match(app,/skip-link/);
 assert.match(app,/modal-dismiss/);
 assert.match(app,/Clear filters/);
});
