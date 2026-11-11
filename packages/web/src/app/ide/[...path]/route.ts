import { proxyApiRequest } from '@/lib/api-proxy.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export {
  proxyApiRequest as GET,
  proxyApiRequest as HEAD,
  proxyApiRequest as POST,
  proxyApiRequest as PUT,
  proxyApiRequest as PATCH,
  proxyApiRequest as DELETE,
  proxyApiRequest as OPTIONS,
};
