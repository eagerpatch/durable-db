import { runWithContext } from '../../src/context';
import { createUser, getUser, listUsers, getUserWithPosts } from './databases/main';

// Export Durable Object classes - the plugin generates these
// @ts-ignore
export { MainDatabaseDO } from 'virtual:shoplayer/databases/__durableObjects';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    // Run the request within a context that provides env and session
    return runWithContext(
      {
        env,
        request,
        session: {
          // In a real app, this would come from authentication
          shop: 'example-shop.myshopify.com',
        },
      },
      async () => {
        try {
          // Route handling
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
      }
    );
  },
};
