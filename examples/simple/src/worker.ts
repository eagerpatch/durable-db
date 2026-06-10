import { setTenantIdResolver } from 'durable-db';
import { studio } from 'durable-db/db';
import { destroyDatabase } from './databases/main';
import { createUser } from './databases/actions/createUser';
import { listUsers } from './databases/actions/listUsers';
import { getUserWithPosts } from './databases/actions/getUsersWithPosts';
import { getUser } from './databases/actions/getUser';

// Export Durable Object classes - the plugin generates these
export * from 'virtual:durable-db/__durableObjects';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    // Resolve tenant from ?tenant= query param or X-Tenant-ID header
    const tenantId = url.searchParams.get('tenant')
      ?? request.headers.get('X-Tenant-ID')
      ?? 'default';
    setTenantIdResolver(() => tenantId);

    // Outerbase Studio UI at /studio
    if (url.pathname === '/studio') {
      return studio(request, env.MAIN_DATABASE_DO);
    }

    try {
      // Route handling
      if (url.pathname === '/database' && request.method === 'DELETE') {
        await destroyDatabase();
        return Response.json({ ok: true, tenantId });
      }

      if (url.pathname === '/users' && request.method === 'POST') {
        const body = await request.json() as { name: string; email: string };
        const user = await createUser({ name: body.name, email: body.email });
        return Response.json(user);
      }

      if (url.pathname === '/users' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') ?? '10');
        const offset = parseInt(url.searchParams.get('offset') ?? '0');
        const users = await listUsers({ limit, offset });
        return Response.json(users);
      }

      if (url.pathname.startsWith('/users/') && request.method === 'GET') {
        const userId = url.pathname.split('/')[2];
        const withPosts = url.searchParams.get('withPosts') === 'true';

        if (withPosts) {
          const result = await getUserWithPosts({ userId });
          if (!result) {
            return new Response('User not found', { status: 404 });
          }
          return Response.json(result);
        }

        const user = await getUser({ userId });
        if (!user) {
          return new Response('User not found', { status: 404 });
        }
        return Response.json(user);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Error:', error);
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
