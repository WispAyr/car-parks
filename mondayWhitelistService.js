// const fetch = require('node-fetch');
const MONDAY_API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjQ5NjA4MTgxNSwiYWFpIjoxMSwidWlkIjo3NDE4Njk1NiwiaWFkIjoiMjAyNS0wNC0wNlQxNjozOTowMy4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6Mjg4Mjg1NTQsInJnbiI6ImV1YzEifQ.GaMX3Dom4zX3dpsfMgpEizvQ27Key9YkTz3TW1XE-zg';

let cachedWhitelists = {};

async function fetchWhitelistsFromMonday() {
  const query = `
    query {
      boards(ids: 1893468235) {
        id
        name
        groups {
          id
          title
          items_page {
            items {
              id
              name
              column_values {
                id
                text
                value
              }
            }
          }
        }
      }
    }
  `;
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': MONDAY_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const data = await response.json();
  console.log('Monday.com API response:', JSON.stringify(data, null, 2));
  if (!data || data.errors) {
    console.error('Error from Monday.com API:', data.errors || data);
    return {};
  }
  if (!data.data || !data.data.boards) {
    console.error('Unexpected Monday.com API response:', data);
    return {};
  }
  const allItems = data.data.boards[0].groups.flatMap(group => group.items_page.items);
  cachedWhitelists = mapWhitelists(allItems);
  return cachedWhitelists;
}

function mapWhitelists(items) {
  const whitelistMap = {};
  for (const item of items) {
    const vrm = item.name.trim().toUpperCase();
    let siteId = '';
    let startDate = null;
    let endDate = null;
    for (const col of item.column_values) {
      if (col.id === 'text_mkr3e6as') siteId = col.text.trim();
      if (col.id === 'date_mkpj4ap1' && col.text) startDate = new Date(col.text);
      if (col.id === 'date_mkqeq1q6' && col.text) endDate = new Date(col.text);
    }
    if (siteId && vrm) {
      if (!whitelistMap[siteId]) whitelistMap[siteId] = [];
      whitelistMap[siteId].push({ vrm, startDate, endDate: endDate || null });
    }
  }
  return whitelistMap;
}

function isWhitelisted(siteId, vrm, today = new Date()) {
  const entries = cachedWhitelists[siteId] || [];
  return entries.some(entry => {
    if (entry.vrm !== vrm.toUpperCase()) return false;
    if (entry.startDate && today < entry.startDate) return false;
    if (entry.endDate && today > entry.endDate) return false;
    return true;
  });
}

module.exports = { fetchWhitelistsFromMonday, isWhitelisted, getCachedWhitelists: () => cachedWhitelists }; 