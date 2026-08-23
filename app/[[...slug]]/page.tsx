import type {Metadata} from "next";
import {headers} from "next/headers";
import {notFound} from "next/navigation";
import {getMePayload} from "../../auth/session";
import SaluApp from "../../components/SaluApp";
import {generateRouteParams,pageDescriptions,pageFromPath,pageTitles} from "../../domain/routes";

type Params={slug?:string[]};

export const dynamic="force-dynamic";

function pathnameFromSlug(slug?:string[]){
 return `/${(slug??[]).join("/")}`;
}

export function generateStaticParams(){
 return generateRouteParams();
}

export async function generateMetadata({params}:{params:Promise<Params>}):Promise<Metadata>{
 const {slug}=await params;
 const page=pageFromPath(pathnameFromSlug(slug));
 if(page==="missing") return {title:"Page not found — Salu"};
 return {title:pageTitles[page],description:pageDescriptions[page]};
}

export default async function Page({params}:{params:Promise<Params>}){
 const {slug}=await params;
 const pathname=pathnameFromSlug(slug);
 const page=pageFromPath(pathname);
 if(page==="missing") notFound();
 let headerStore:Headers|undefined;
 try{headerStore=await headers()}catch{headerStore=undefined}
 const me=await getMePayload(undefined, headerStore);
 return <SaluApp initialPage={page} initialSession={me.member} authSurface={me.providers} returnTo={pathname}/>;
}
