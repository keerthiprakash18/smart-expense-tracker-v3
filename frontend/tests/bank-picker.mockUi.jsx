import React from 'react';
export function PageHeader({title,description}){return <header><h1>{title}</h1><p>{description}</p></header>}
export function Surface({children}){return <section style={{padding:16,border:'1px solid gray',marginBottom:12}}>{children}</section>}
export function money(value, currency){return String(currency||'₹')+String(value)}
