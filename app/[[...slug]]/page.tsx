import type {Metadata} from "next";
import {notFound} from "next/navigation";
import SaluApp from "../../components/SaluApp";
import {generateRouteParams,pageDescriptions,pageFromPath,pageTitles} from "../../domain/routes";

type Params={slug?:string[]};

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
 const page=pageFromPath(pathnameFromSlug(slug));
 if(page==="missing") notFound();
 return <SaluApp initialPage={page}/>;
}
