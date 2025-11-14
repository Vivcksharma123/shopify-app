import { useState, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
      price: parseFloat(variant.node.price),
      originalPrice: parseFloat(variant.node.price),
      productTitle: product.node.title
    }))
  );
  
  console.log("✅ Processed variants:", variants);
  
  // Fetch variant prices from database with error handling
  let originalPricesMap = {};
  let currentPricesMap = {};
  
  try {
    const variantPricesFromDB = await prisma.variantPrice.findMany();
    console.log("💾 Database records found:", variantPricesFromDB.length);
    variantPricesFromDB.forEach(vp => {
      originalPricesMap[vp.variantId] = vp.originalPrice;
      currentPricesMap[vp.variantId] = vp.currentPrice;
    });
    console.log("💾 Original prices map:", originalPricesMap);
    console.log("💾 Current prices map:", currentPricesMap);
  } catch (error) {
    console.error("❌ Database fetch failed:", error);
    console.log("⚠️ Using empty price maps as fallback");
  }
  
  return { variants, originalPricesFromDB: originalPricesMap, currentPricesFromDB: currentPricesMap };
};

export const action = async ({ request }) => {
  console.log("🟢 action started");

  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  console.log("📦 formData received");
  console.log("🔍 Session:", session);
  console.log("🔍 Shop:", session.shop);
  console.log("🔍 Access token exists:", !!session.accessToken);

  const actionType = formData.get("actionType");
  
  if (actionType === "syncPrices") {
    // Handle sync prices to database
    const currentPrices = JSON.parse(formData.get("currentPrices") || "{}");
    console.log("💾 Syncing prices to database:", currentPrices);
    
    try {
      for (const [variantId, price] of Object.entries(currentPrices)) {
        await prisma.variantPrice.upsert({
          where: { variantId },
          update: { originalPrice: parseFloat(price), currentPrice: parseFloat(price) },
          create: { variantId, originalPrice: parseFloat(price), currentPrice: parseFloat(price) }
        });
      }
      return { success: true, message: "Original prices synced to database" };
    } catch (error) {
      console.error("❌ Database sync failed:", error);
      return { success: false, message: "Failed to sync prices to database" };
    }
  }
  
  if (actionType === "updatePrices") {
    // Handle price updates and save to database
    const newPrices = JSON.parse(formData.get("newPrices") || "{}");
    console.log("💾 Saving calculated prices to database:", newPrices);
    
    try {
      // Save new calculated prices to database (only update currentPrice, keep originalPrice unchanged)
      for (const [variantId, price] of Object.entries(newPrices)) {
        console.log(`💾 Updating current price for variant ${variantId} to ${price}`);
        
        // Get original price from the originalPrices data sent from frontend
        const originalPrices = JSON.parse(formData.get("originalPrices") || "{}");
        const originalPrice = originalPrices[variantId];
        
        const result = await prisma.variantPrice.upsert({
          where: { variantId },
          update: { currentPrice: parseFloat(price) },
          create: { variantId, originalPrice: parseFloat(originalPrice), currentPrice: parseFloat(price) }
        });
        console.log(`✅ Update result:`, result);
      }
      console.log("✅ All current prices updated in database successfully");
    } catch (dbError) {
      console.error("❌ Database save failed:", dbError);
    }
  }

  const multipliers = JSON.parse(formData.get("multipliers") || "{}");
  const originalPrices = JSON.parse(formData.get("originalPrices") || "{}");
  console.log("🧮 multipliers:", multipliers);
  console.log("💰 originalPrices:", originalPrices);
  
  let updatedCount = 0;
  let errorCount = 0;
  let errorDetails = [];

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

  console.log("🔍 Processing products...");
  
  for (const product of data.data.products.edges) {
    console.log(`📦 Product: ${product.node.title}`);
    
    for (const v of product.node.variants.edges) {
      const id = v.node.id;
      const multiplier = multipliers[id];
      
      console.log(`🔍 Checking variant ${id}:`, {
        hasMultiplier: !!multiplier,
        multiplierValue: multiplier,
        currentPrice: v.node.price
      });
      
      if (!multiplier) {
        console.log(`⏭️ Skipping variant ${id} - no multiplier`);
        continue;
      }

      const originalPrice = originalPrices[id] ? parseFloat(originalPrices[id]) : parseFloat(v.node.price);
      const multiplierValue = parseFloat(multiplier);
      const newPrice = (originalPrice * multiplierValue).toFixed(2);
      
      console.log(`🧾 Updating variant ${id}: ${originalPrice} × ${multiplierValue} = ${newPrice}`);

      try {
        // Try the correct mutation for API version 2026-01
        const updateResponse = await admin.graphql(`
          mutation productVariantUpdate($input: ProductVariantInput!) {
            productVariantUpdate(input: $input) {
              productVariant {
                id
                price
              }
              userErrors {
                field
                message
              }
            }
          }
        `, {
          variables: {
            input: {
              id: id,
              price: newPrice
            }
          }
        });

        const result = await updateResponse.json();
        console.log("💬 Shopify response:", result);

        if (result.data?.productVariantUpdate?.productVariant) {
          console.log(`✅ Updated variant ${id} to $${newPrice}`);
          updatedCount++;
        } else if (result.data?.productVariantUpdate?.userErrors?.length > 0) {
          console.error("❌ Update failed:", result.data.productVariantUpdate.userErrors);
          errorDetails.push({ variantId: id, errors: result.data.productVariantUpdate.userErrors });
          errorCount++;
        } else {
          console.error("❌ Unexpected response:", result);
          errorDetails.push({ variantId: id, error: "Unexpected response", response: result });
          errorCount++;
        }
      } catch (err) {
        console.error("🔥 API error:", err);
        
        // If the mutation doesn't exist, try REST API as fallback
        if (err.message.includes("doesn't exist on type 'Mutation'")) {
          console.log("🔄 Trying REST API fallback...");
          try {
            const numericId = id.split('/').pop();
            const restResponse = await fetch(`https://${session.shop}/admin/api/2025-10/variants/${numericId}.json`, {
              method: 'PUT',
              headers: {
                'X-Shopify-Access-Token': session.accessToken,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                variant: {
                  id: parseInt(numericId),
                  price: newPrice
                }
              })
            });
            
            if (restResponse.ok) {
              console.log(`✅ Updated via REST: ${id} to $${newPrice}`);
              updatedCount++;
            } else {
              const restError = await restResponse.text();
              console.error("❌ REST API failed:", restError);
              errorDetails.push({ variantId: id, error: `REST API failed: ${restError}` });
              errorCount++;
            }
          } catch (restErr) {
            console.error("🔥 REST fallback failed:", restErr);
            errorDetails.push({ variantId: id, error: restErr.message });
            errorCount++;
          }
        } else {
          errorDetails.push({ variantId: id, error: err.message });
          errorCount++;
        }
      }
    }
  }

  console.log("🏁 action completed");
  console.log(`📊 Summary: ${updatedCount} updated, ${errorCount} errors`);
  
  return { 
    success: errorCount === 0, 
    updatedCount, 
    errorCount,
    errorDetails,
    message: `Updated ${updatedCount} variants${errorCount > 0 ? ` (${errorCount} errors)` : ''}`
  };
};

export default function VariantsPage() {
  const { variants, originalPricesFromDB, currentPricesFromDB } = useLoaderData();
  const fetcher = useFetcher();
  const [multiplier, setMultiplier] = useState({});
  const [globalMultiplier, setGlobalMultiplier] = useState('');
  const [updatedPrices, setUpdatedPrices] = useState({});
  const [originalPrices, setOriginalPrices] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  
  console.log("🔍 Component variants:", variants);
  console.log("📏 Variants length:", variants?.length);

  useEffect(() => {
    // Use original prices from database or fallback to current prices
    const originals = {};
    variants.forEach(variant => {
      originals[variant.id] = originalPricesFromDB[variant.id] || variant.originalPrice;
    });
    setOriginalPrices(originals);
    setUpdatedPrices(currentPricesFromDB);
  }, [variants, originalPricesFromDB, currentPricesFromDB]);

  const handleChange = (id, value) => {
    console.log('🔄 Multiplier changed:', { id, value });
    setMultiplier({ ...multiplier, [id]: value });
  };

  const applyGlobalMultiplier = () => {
    if (!globalMultiplier || globalMultiplier === '') return;
    
    const newMultipliers = {};
    variants.forEach(variant => {
      newMultipliers[variant.id] = globalMultiplier;
    });
    setMultiplier(newMultipliers);
    console.log('🌍 Applied global multiplier:', globalMultiplier);
  };

  const syncLatestPrices = () => {
    console.log('🔄 Syncing latest prices to database...');
    
    // Prepare current prices for database sync
    const currentPrices = {};
    variants.forEach(variant => {
      currentPrices[variant.id] = variant.price;
    });
    
    const formData = new FormData();
    formData.append("actionType", "syncPrices");
    formData.append("currentPrices", JSON.stringify(currentPrices));
    fetcher.submit(formData, { method: "POST" });
    
    console.log('📤 Sync request submitted to database');
  };

  const filteredVariants = variants.filter(variant => 
    variant.productTitle.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleUpdate = () => {
    debugger;
    console.log('🚀 Update button clicked');
    console.log('📊 Current multipliers:', multiplier);
    console.log('📊 Multiplier keys:', Object.keys(multiplier));
    console.log('📊 Variant IDs:', variants.map(v => v.id));
    
    // Calculate new prices based on ORIGINAL prices
    const newPrices = {};
    variants.forEach(variant => {
      if (multiplier[variant.id] && multiplier[variant.id] !== '') {
        // Always calculate from original price, not current price
        const originalPrice = originalPrices[variant.id] || variant.originalPrice;
        newPrices[variant.id] = (originalPrice * parseFloat(multiplier[variant.id])).toFixed(2);
        console.log(`💰 Calculated price for ${variant.title}: $${originalPrice} × ${multiplier[variant.id]} = $${newPrices[variant.id]}`);
      }
    });
    
    const updatedPricesData = { ...updatedPrices, ...newPrices };
    setUpdatedPrices(updatedPricesData);
    console.log('💾 Updated prices data:', updatedPricesData);
    
    // Submit all data in one request
    const formData = new FormData();
    formData.append("actionType", "updatePrices");
    formData.append("multipliers", JSON.stringify(multiplier));
    formData.append("originalPrices", JSON.stringify(originalPrices));
    formData.append("newPrices", JSON.stringify(newPrices));
    fetcher.submit(formData, { method: "POST" });
    console.log('📤 Update request submitted to server');
    
    // Clear multipliers after update
    setMultiplier({});
    setGlobalMultiplier('');
    console.log('🧹 Multipliers cleared');
  };
  
  // Show success message
  useEffect(() => {
    if (fetcher.data?.success) {
      console.log('✅ Update successful:', fetcher.data.message);
      // Refresh page to show updated prices
      window.location.reload();
    } else if (fetcher.data?.success === false) {
      console.error('❌ Update failed:', fetcher.data.message);
      if (fetcher.data.errorDetails) {
        console.error('🔍 Error details:', fetcher.data.errorDetails);
        fetcher.data.errorDetails.forEach((error, index) => {
          console.error(`Error ${index + 1}:`, error);
        });
      }
    }
  }, [fetcher.data]);

  return (
    <s-page heading="Variant Multiplier">
      <s-section heading="Search & Controls">
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={{ fontWeight: 'bold' }}>Search:</label>
            <input
              type="text"
              placeholder="Search by product name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ width: '200px', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
            />
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <s-button variant="secondary" onClick={syncLatestPrices}>
              🔄 Sync Latest Prices
            </s-button>
          </div>
        </div>
      </s-section>
      <s-section heading="Variant Table">
        {!variants || variants.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
            No variants found. Check console for debug info.
          </div>
        ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Product</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Variant</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>SKU</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Original Price</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>Multiplier</th>
              <th style={{ padding: '12px', textAlign: 'left', fontWeight: 'bold' }}>New Price</th>
            </tr>
          </thead>
          <tbody>
            {filteredVariants.map((variant) => {
              const hasMultiplier = multiplier[variant.id] && multiplier[variant.id] !== '';
              const originalPrice = originalPrices[variant.id] || variant.originalPrice;
              const newPrice = hasMultiplier ? (originalPrice * parseFloat(multiplier[variant.id])).toFixed(2) : null;
              
              return (
                <tr key={variant.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '12px', fontWeight: 'bold' }}>{variant.productTitle}</td>
                  <td style={{ padding: '12px' }}>{variant.title}</td>
                  <td style={{ padding: '12px' }}>{variant.sku || "—"}</td>
                  <td style={{ padding: '12px', color: '#666' }}>${originalPrice.toFixed(2)}</td>
                  <td style={{ padding: '12px' }}>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="1.0"
                      value={multiplier[variant.id] || ""}
                      onChange={(event) => handleChange(variant.id, event.target.value)}
                      style={{ width: '100px', padding: '6px', border: '1px solid #ccc', borderRadius: '4px' }}
                    />
                  </td>
                  <td style={{ 
                    padding: '12px', 
                    fontWeight: hasMultiplier ? 'bold' : 'normal',
                    color: hasMultiplier ? '#28a745' : '#666'
                  }}>
                    {hasMultiplier ? `$${newPrice}` : updatedPrices[variant.id] ? `$${parseFloat(updatedPrices[variant.id]).toFixed(2)}` : `$${originalPrice.toFixed(2)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
        {filteredVariants && filteredVariants.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <s-button 
            variant="primary" 
            onClick={handleUpdate}
            loading={fetcher.state === "submitting"}
          >
            {fetcher.state === "submitting" ? "Updating..." : "Update Price"}
          </s-button>
          {fetcher.data?.message && (
            <div style={{ marginTop: '8px', padding: '8px', backgroundColor: fetcher.data.success ? '#d4edda' : '#f8d7da', borderRadius: '4px' }}>
              {fetcher.data.message}
            </div>
          )}
        </div>
        )}
      </s-section>
    </s-page>
  );
}