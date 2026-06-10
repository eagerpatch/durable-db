import { listProducts } from "../../databases/actions/listProducts";
import { ProductForm } from "./productForm";

export const Products = async () => {
  const products = await listProducts({ limit: 50, offset: 0 });

  return (
    <div>
      <div className="flex gap-2 mb-2">
        <h1>Products</h1>
        <span className="badge badge-rpc">RPC Transport</span>
      </div>
      <p className="text-muted mb-4">
        Product catalog stored in the <code className="mono">main</code>{" "}
        database using standard RPC transport.
      </p>

      <div className="info-box mb-4">
        <p className="text-sm">
          Each action call (create, read, list) counts as 1 RPC call. This is
          the default and works well for low-to-medium volume operations.
        </p>
      </div>

      <ProductForm />

      <h2 className="mt-4">
        Product List ({products.length} item{products.length !== 1 ? "s" : ""})
      </h2>

      {products.length === 0 ? (
        <p className="text-sm text-muted mt-4">
          No products yet. Add one above!
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th className="text-right">Price</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product: any) => (
              <tr key={product.id}>
                <td style={{ fontWeight: 500 }}>{product.name}</td>
                <td className="text-muted">
                  {product.description || "\u2014"}
                </td>
                <td className="text-right mono">
                  ${((product.price_in_cents ?? product.priceInCents) / 100).toFixed(2)}
                </td>
                <td className="text-xs text-muted">
                  {new Date(product.created_at ?? product.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
