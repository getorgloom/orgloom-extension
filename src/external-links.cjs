'use strict';
// Browser navigation is a user action, never a general-purpose URL bridge.
function externalLink(value, identity) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Unsupported external link.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Only HTTPS links are supported.');
  const origin = new URL(identity.instanceUrl).origin;
  const record = /^\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\/?$/.test(url.pathname);
  const lightning = /^\/lightning\/r\/[A-Za-z][A-Za-z0-9_]*\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\/view\/?$/.test(url.pathname);
  if (url.origin === origin && (record || lightning) && !url.search && !url.hash) return url.href;
  if (url.origin === 'https://orgloom.com' && /^\/docs(?:\/[a-z0-9-]+)*\/?$/.test(url.pathname) && !url.search) return url.href;
  if (url.origin === 'https://orgloom.com' && url.pathname === '/' && !url.search && !url.hash) return url.href;
  throw new Error('Only records in the connected Salesforce org and the Org Loom website or documentation can be opened.');
}
module.exports = { externalLink };
