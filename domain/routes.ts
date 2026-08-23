import type {Page} from "./mock-data";

export const pagePath: Record<Page,string>={
 home:"/",
 atlas:"/atlas",
 discover:"/explore",
 packages:"/plans",
 about:"/about",
 apps:"/apps",
 wallet:"/credits",
 bookings:"/appointments",
 household:"/profile",
 offers:"/offers",
 pricing:"/membership",
 onboard:"/join",
 "provider-apply":"/apply",
 provider:"/provider",
 "provider-signin":"/provider/signin",
 admin:"/admin",
 signin:"/signin",
};

const pathAliases: Record<string,Page>={
 "/":"home",
 "/home":"home",
 "/atlas":"atlas",
 "/explore":"discover",
 "/discover":"discover",
 "/plans":"packages",
 "/packages":"packages",
 "/about":"about",
 "/apps":"apps",
 "/credits":"wallet",
 "/wallet":"wallet",
 "/appointments":"bookings",
 "/bookings":"bookings",
 "/profile":"household",
 "/household":"household",
 "/offers":"offers",
 "/membership":"pricing",
 "/pricing":"pricing",
 "/join":"onboard",
 "/onboard":"onboard",
 "/apply":"provider-apply",
 "/provider":"provider",
 "/provider/signin":"provider-signin",
 "/admin":"admin",
 "/signin":"signin",
};

export const pageTitles: Record<Page,string>={
 home:"Salu — Your health concierge",
 atlas:"Atlas — Salu",
 discover:"Explore Miami — Salu",
 packages:"Plans & Packages — Salu",
 about:"About — Salu",
 apps:"Connected apps — Salu",
 wallet:"Credits — Salu",
 bookings:"Appointments — Salu",
 household:"Profile — Salu",
 offers:"Member moments — Salu",
 pricing:"Membership — Salu",
 onboard:"Join Salu",
 "provider-apply":"Apply to Salu",
 provider:"Provider workspace — Salu",
 "provider-signin":"Provider sign in — Salu",
 admin:"Miami pipeline — Salu",
 signin:"Sign in — Salu",
};

export const pageDescriptions: Record<Page,string>={
 home:"Premium self-pay wellness, recovery and personal care in Miami.",
 atlas:"Ask Atlas for general wellness education and to coordinate independent Miami services.",
 discover:"Browse Salu’s Miami marketplace of at-home, virtual and in-studio wellness.",
 packages:"Choose Member, Gold or Platinum and build a routine with curated packages.",
 about:"Salu is your health concierge — premium in-home wellness, beautifully handled.",
 apps:"Prototype connections that show how Atlas could coordinate around your week.",
 wallet:"Salu Credits are self-pay marketplace funds. Gold and Platinum Credits roll automatically.",
 bookings:"Review, move or cancel the appointments Atlas keeps close at hand.",
 household:"Your Salu snapshot, home base and account preferences.",
 offers:"Quietly useful member moments selected around your membership.",
 pricing:"Member is free. Gold is $200 monthly for 10% off. Platinum is $500 monthly for 20% off.",
 onboard:"Join Salu and start a demo membership with Credits ready to use.",
 "provider-apply":"Apply as a named independent provider — LMT or other solo licensed person — in Miami.",
 provider:"Accept appointment requests, set up Stripe Connect payouts, and look up your Apply status.",
 "provider-signin":"Sign in with email, or continue with Google or Apple, to fill member appointment requests.",
 admin:"Staff-only Miami review queue for named providers, plus a labeled demo operating view of funds and volume.",
 signin:"Sign in with email, or continue with Google or Apple, to open your Salu membership.",
};

export const publicPages: Page[] = ["signin","provider-apply","provider","provider-signin"];

export function isMemberShell(page: Page): boolean {
 return !publicPages.includes(page);
}

export function pageFromPath(pathname:string):Page|"missing"{
 const clean=pathname.replace(/\/+$/,"")||"/";
 return pathAliases[clean]??"missing";
}

export function generateRouteParams(){
 const slugs=Object.keys(pathAliases)
  .filter(path=>path!=="/")
  .map(path=>path.replace(/^\//,"").split("/"));
 return [{slug:[]},...slugs.map(slug=>({slug}))];
}
