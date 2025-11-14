import { useState, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  const response = await admin.graphql(`
    query getProducts($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            title
            variants(first: 250) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                }
              }
            }
          }
        }
      }
    }
  `, {
    variables: { first: 10 }
  });

  const data = await response.json();
  console.log("📊 Raw GraphQL response:", JSON.stringify(data, null, 2));
  
  if (!data?.data?.products?.edges) {
    console.error("❌ No products found in GraphQL response");
    return { variants: [] };
  }
  
  const variants = data.data.products.edges.flatMap(product => 
    product.node.variants.edges.map(variant => ({
      id: variant.node.id,
      title: variant.node.title,
      sku: variant.node.sku,
      price: parseFloat(variant.node.price)
    }))
  );
  
  console.log("✅ Processed variants:", variants);
  return { variants };
};

export const action = async ({ request }) => {
  console.log("🟢 action started");

  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  console.log("📦 formData received");

  const multipliers = JSON.parse(formData.get("multipliers") || "{}");
  console.log("🧮 multipliers:", multipliers);

  // Fetch products
  const response = await admin.graphql(`
    query getProducts($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            title
            variants(first: 250) {
              edges {
                node {
                  id
                  price
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { first: 10 } });

  const data = await response.json();
  console.log("📊 Product data received:", JSON.stringify(data, null, 2));

  if (!data?.data?.products) {
    console.error("❌ No products found in response:", data);
    return { success: false, error: "No products found" };
  }

  for (const product of data.data.products.edges) {
    for (const v of product.node.variants.edges) {
      const id = v.node.id;
      const multiplier = multipliers[id];
      if (!multiplier) continue;

      const newPrice = (parseFloat(v.node.price) * parseFloat(multiplier)).toFixed(2);
      console.log(`🧾 Updating variant ${id} → ${newPrice}`);

      try {
        const updateResponse = await admin.graphql(`
          mutation UpdateVariantPrice($id: ID!, $price: Decimal!) {
            productVariantUpdate(input: { id: $id, price: $price }) {
              productVariant { id price }
              userErrors { field message }
            }
          }
        `, {
          variables: { id, price: newPrice },
        });

        const result = await updateResponse.json();
        console.log("💬 Shopify response:", JSON.stringify(result, null, 2));

        if (result.data.productVariantUpdate.userErrors.length > 0) {
          console.error("❌ Variant update failed:", result.data.productVariantUpdate.userErrors);
        } else {
          console.log(`✅ Updated variant ${id} to $${newPrice}`);
        }
      } catch (err) {
        console.error("🔥 Mutation error:", err);
      }
    }
  }

  console.log("🏁 action completed");
  return { success: true };
};

export default function VariantsPage() {
  const { variants } = useLoaderData();
  const fetcher = useFetcher();
  const [multiplier, setMultiplier] = useState({});
  const [updatedPrices, setUpdatedPrices] = useState({});
  
  console.log("🔍 Component variants:", variants);
  console.log("📏 Variants length:", variants?.length);

  useEffect(() => {
    // Load saved updated prices from localStorage
    const saved = localStorage.getItem('updatedPrices');
    if (saved) {
      setUpdatedPrices(JSON.parse(saved));
    }
  }, []);

  const handleChange = (id, value) => {
    console.log('🔄 Multiplier changed:', { id, value });
    setMultiplier({ ...multiplier, [id]: value });
  };

  const handleUpdate = () => {
    console.log('🚀 Update button clicked');
    console.log('📊 Current multipliers:', multiplier);
    
    // Calculate and store new prices
    const newPrices = {};
    variants.forEach(variant => {
      if (multiplier[variant.id] && multiplier[variant.id] !== '') {
        newPrices[variant.id] = (variant.price * parseFloat(multiplier[variant.id])).toFixed(2);
        console.log(`💰 Calculated price for ${variant.title}: $${newPrices[variant.id]}`);
      }
    });
    
    const updatedPricesData = { ...updatedPrices, ...newPrices };
    setUpdatedPrices(updatedPricesData);
    console.log('💾 Updated prices data:', updatedPricesData);
    
    // Save to localStorage
    localStorage.setItem('updatedPrices', JSON.stringify(updatedPricesData));
    console.log('🗄️ Saved to localStorage');
    
    const formData = new FormData();
    formData.append("multipliers", JSON.stringify(multiplier));
    fetcher.submit(formData, { method: "POST" });
    console.log('📤 Form submitted to server');
    
    // Clear multipliers after update
    setMultiplier({});
    console.log('🧹 Multipliers cleared');
  };

  return (
    <s-page heading="Variant Multiplier">
      <s-section heading="Variant Table">
        {!variants || variants.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
            No variants found. Check console for debug info.
          </div>
        ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #ddd' }}>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Variant</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>SKU</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Price</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Multiplier</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Updated Price</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => (
              <tr key={variant.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '12px' }}>{variant.title}</td>
                <td style={{ padding: '12px' }}>{variant.sku || "—"}</td>
                <td style={{ padding: '12px' }}>${variant.price.toFixed(2)}</td>
                <td style={{ padding: '12px' }}>
                  <input
                    type="number"
                    step="0.1"
                    value={multiplier[variant.id] || ""}
                    onChange={(event) => handleChange(variant.id, event.target.value)}
                    style={{ width: '100px', padding: '4px', border: '1px solid #ccc', borderRadius: '4px' }}
                  />
                </td>
                <td style={{ padding: '12px' }}>
                  {multiplier[variant.id] && multiplier[variant.id] !== ''
                    ? `$${(variant.price * parseFloat(multiplier[variant.id])).toFixed(2)}`
                    : updatedPrices[variant.id]
                    ? `$${parseFloat(updatedPrices[variant.id]).toFixed(2)}`
                    : `$${variant.price.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
        {variants && variants.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <s-button 
            variant="primary" 
            onClick={handleUpdate}
            loading={fetcher.state === "submitting"}
          >
            Update Price
          </s-button>
        </div>
        )}
      </s-section>
    </s-page>
  );
}