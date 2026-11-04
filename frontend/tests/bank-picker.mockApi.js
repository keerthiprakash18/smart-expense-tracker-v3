const api = {
  async post(route, body) {
    const file = body.get('file');
    window.__bankPickerRequests ||= [];
    window.__bankPickerRequests.push({
      route, filename: file?.name, size: file?.size,
      format: file?.type, account: body.get('account_id'),
      password: body.get('pdf_password'),
    });
    if (route.includes('/preview/')) return { data: { rows: [
      {index:0,date:'2026-11-04',description:'Fake bank statement expense',
        amount:'55.00',transaction_type:'EXPENSE',category:'Food & Dining',status:'ready'},
    ]}};
    return {data:{created:1,already_imported:0,message:'Synthetic test import'}};
  },
};
export default api;