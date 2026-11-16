exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode:405, headers:{'Content-Type':'application/json'}, body:JSON.stringify({ok:false,error:'Method not allowed'}) };
  try {
    const start=String(event.queryStringParameters?.start||'');
    const end=String(event.queryStringParameters?.end||'');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end<start) return {statusCode:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:false,error:'Valid start and end dates are required'})};
    const url=process.env.LEAVE_SHEETS_SYNC_URL, secret=process.env.GOOGLE_SHEETS_SYNC_SECRET;
    if (!url || !secret) throw new Error('Google Sheets connection is not configured');
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({secret,action:'listApproved',start,end})});
    const data=await response.json();
    if (!response.ok || data.ok!==true) throw new Error(data.error||'Google Sheets request failed');
    return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({ok:true,records:data.records||[]})};
  } catch(error) {
    console.error('approved-leaves error:',error);
    return {statusCode:502,headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:false,error:error.message||'Unable to load approved leaves'})};
  }
}