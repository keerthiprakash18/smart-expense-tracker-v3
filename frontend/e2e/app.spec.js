import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const AUTH_VERSION='2026-10-09-cookie-refresh-v1';
const profile={username:'tester@example.com',name:'Test User',email:'tester@example.com',currency:'₹',monthly_budget:50000};
const analytics={
  month:{income:50000,spend:12000,budget:50000,budget_percent:24,categories:[{name:'Food & Dining',value:7000},{name:'Travel',value:5000}]},
  totals:{income:100000,spend:42000,average_spend:2100,net:58000,transaction_count:20},
  months:[{key:'2026-09',label:'Sep 26',income:50000,spend:30000,net:20000},{key:'2026-10',label:'Oct 26',income:50000,spend:12000,net:38000}],
};

test.beforeEach(async({page})=>{
  await page.addInitScript(({version})=>{
    localStorage.setItem('smart_expense_intro_seen','true');
    localStorage.setItem('smart_expense_auth_version',version);
  },{version:AUTH_VERSION});
});

async function mockApi(page){
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    const path=url.pathname;
    const method=route.request().method();
    if(path==='/api/profile/') return route.fulfill({json:profile});
    if(path==='/api/accounts/') return route.fulfill({json:[{id:1,name:'Primary Bank',account_type:'BANK',balance:38000}]});
    if(path==='/api/dashboard/') return route.fulfill({json:{account_balance:38000,lent_remaining:0,borrowed_remaining:0,monthly_budget:50000}});
    if(path==='/api/expenses/'&&method==='GET') return route.fulfill({json:{count:1,page:1,page_size:50,total_pages:1,has_next:false,has_previous:false,results:[{id:1,title:'Lunch',amount:'500.00',transaction_type:'EXPENSE',category:'Food & Dining',account_name:'Primary Bank',date:'2026-10-09'}]}});
    if(path==='/api/v3/analytics/summary/') return route.fulfill({json:analytics});
    if(path==='/api/v3/insights/') return route.fulfill({json:{insights:[]}});
    if(path==='/api/v3/ai/forecast/') return route.fulfill({json:{categories:[],days_left:22}});
    if(path==='/api/v3/notifications/') return route.fulfill({json:[]});
    return route.fulfill({status:200,json:{}});
  });
}

async function assertA11y(page){
  const result=await new AxeBuilder({page}).analyze();
  const severe=result.violations.filter(v=>['serious','critical'].includes(v.impact));
  expect(severe,JSON.stringify(severe,null,2)).toEqual([]);
}

test('login has no serious accessibility violations',async({page})=>{
  await page.goto('/#/login');
  await expect(page.getByRole('heading',{name:/sign in to your workspace/i})).toBeVisible();
  await expect(page.getByLabel('Toggle theme')).toBeVisible();
  await assertA11y(page);
});

test('overview uses server analytics and remains accessible',async({page})=>{
  await mockApi(page);
  await page.addInitScript(()=>localStorage.setItem('access_token','test-access-token'));
  await page.goto('/#/');
  await expect(page.getByText('This month spent')).toBeVisible();
  const spendCard=page.locator('.metric-card').filter({hasText:'This month spent'});
  await expect(spendCard.getByText(/12,000/)).toBeVisible();
  await assertA11y(page);
});

test('mobile navigation exposes More',async({page,isMobile})=>{
  test.skip(!isMobile,'mobile project only');
  await mockApi(page);
  await page.addInitScript(()=>localStorage.setItem('access_token','test-access-token'));
  await page.goto('/#/');
  await page.getByRole('link',{name:/more/i}).click();
  await expect(page.getByRole('heading',{name:'More tools'})).toBeVisible();
  await expect(page.getByRole('button',{name:/analytics/i})).toBeVisible();
});
