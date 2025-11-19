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
    
    // Auto-sync currentPrice if different from Shopify price
    for (const variant of variants) {
      const dbRecord = variantPricesFromDB.find(vp => vp.variantId === variant.id);
      const shopifyPrice = parseFloat(variant.price);
      
      if (dbRecord && Math.abs(dbRecord.currentPrice - shopifyPrice) > 0.001) {
        console.log(`🔄 Auto-syncing ${variant.id}: DB=${dbRecord.currentPrice} -> Shopify=${shopifyPrice}`);
        
        await prisma.variantPrice.update({
          where: { variantId: variant.id },
          data: { currentPrice: shopifyPrice }
        });
        
        dbRecord.currentPrice = shopifyPrice;
        console.log(`✅ Auto-synced currentPrice for ${variant.id}`);
      }
    }
    
    variantPricesFromDB.forEach(vp => {
      originalPricesMap[vp.variantId] = vp.originalPrice;
      currentPricesMap[vp.variantId] = vp.currentPrice;
    });
    console.log("💾 Original prices map:", originalPricesMap);
    console.log("💾 Current prices map:", currentPricesMap);
  } catch (error) {
    console.error("❌ Database operations failed:", error);
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
    const originalPrices = JSON.parse(formData.get("originalPrices") || "{}");
    console.log("💾 Saving calculated prices to database:", newPrices);
    console.log("💾 Saving original prices to database:", originalPrices);
    
    try {
      // First update all original prices in database
      for (const [variantId, originalPrice] of Object.entries(originalPrices)) {
        if (originalPrice) {
          await prisma.variantPrice.upsert({
            where: { variantId },
            update: { originalPrice: parseFloat(originalPrice) },
            create: { variantId, originalPrice: parseFloat(originalPrice), currentPrice: parseFloat(originalPrice) }
          });
          console.log(`💾 Updated original price for variant ${variantId} to ${originalPrice}`);
        }
      }
      
      // Then update calculated prices
      for (const [variantId, price] of Object.entries(newPrices)) {
        console.log(`💾 Updating current price for variant ${variantId} to ${price}`);
        
        const originalPrice = originalPrices[variantId];
        
        const result = await prisma.variantPrice.upsert({
          where: { variantId },
          update: { currentPrice: parseFloat(price) },
          create: { variantId, originalPrice: parseFloat(originalPrice), currentPrice: parseFloat(price) }
        });
        console.log(`✅ Update result:`, result);
      }
      console.log("✅ All prices updated in database successfully");
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
          
          // Auto-update database currentPrice only (keep originalPrice unchanged)
          try {
            const originalPrices = JSON.parse(formData.get("originalPrices") || "{}");
            const originalPrice = originalPrices[id] || parseFloat(newPrice);
            
            await prisma.variantPrice.upsert({
              where: { variantId: id },
              update: { currentPrice: parseFloat(newPrice) },
              create: { variantId: id, originalPrice: parseFloat(originalPrice), currentPrice: parseFloat(newPrice) }
            });
            console.log(`💾 Database currentPrice synced for ${id}`);
          } catch (dbErr) {
            console.error(`❌ Database currentPrice sync failed for ${id}:`, dbErr);
          }
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
              
              // Auto-update database currentPrice only (keep originalPrice unchanged)
              try {
                const originalPrices = JSON.parse(formData.get("originalPrices") || "{}");
                const originalPrice = originalPrices[id] || parseFloat(newPrice);
                
                await prisma.variantPrice.upsert({
                  where: { variantId: id },
                  update: { currentPrice: parseFloat(newPrice) },
                  create: { variantId: id, originalPrice: parseFloat(originalPrice), currentPrice: parseFloat(newPrice) }
                });
                console.log(`💾 Database currentPrice synced via REST for ${id}`);
              } catch (dbErr) {
                console.error(`❌ Database currentPrice sync failed for ${id}:`, dbErr);
              }
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
  const [multiplier, setMultiplier] = useState(() => {
    // Load multipliers from localStorage on initial render
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('variantMultipliers');
      return saved ? JSON.parse(saved) : {};
    }
    return {};
  });
  const [globalMultiplier, setGlobalMultiplier] = useState('');
  const [updatedPrices, setUpdatedPrices] = useState({});
  const [originalPrices, setOriginalPrices] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  
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
    // Prevent negative values
    if (value < 0) return;
    console.log('🔄 Multiplier changed:', { id, value });
    const newMultipliers = { ...multiplier, [id]: value };
    setMultiplier(newMultipliers);
    // Save to localStorage
    localStorage.setItem('variantMultipliers', JSON.stringify(newMultipliers));
  };

  const handleOriginalPriceChange = (id, value) => {
    // Prevent negative values
    if (value < 0) return;
    console.log('🔄 Original price changed:', { id, value });
    setOriginalPrices({ ...originalPrices, [id]: parseFloat(value) || 0 });
  };

  const applyGlobalMultiplier = () => {
    if (!globalMultiplier || globalMultiplier === '') return;
    
    const newMultipliers = {};
    variants.forEach(variant => {
      newMultipliers[variant.id] = globalMultiplier;
    });
    setMultiplier(newMultipliers);
    // Save to localStorage
    localStorage.setItem('variantMultipliers', JSON.stringify(newMultipliers));
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
    variant.productTitle.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (variant.sku && variant.sku.toLowerCase().includes(searchTerm.toLowerCase()))
  );
  
  // Pagination logic
  const totalPages = Math.ceil(filteredVariants.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedVariants = filteredVariants.slice(startIndex, startIndex + itemsPerPage);
  
  const goToPage = (page) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  };

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
    
    // Keep multipliers after update for user convenience
    console.log('✅ Update submitted, keeping multiplier values');
  };
  
  // Show success message
  useEffect(() => {
    if (fetcher.data?.success) {
      console.log('✅ Update successful:', fetcher.data.message);
      // Reload page to show updated prices, multipliers will persist via localStorage
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
    <s-page heading="Variant Price Multiplier" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', minHeight: '100vh' }}>
      <s-section heading="Search & Controls" style={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', borderRadius: '12px', padding: '20px', marginBottom: '20px', boxShadow: '0 8px 32px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <label style={{ fontWeight: '500', color: '#000', fontSize: '14px' }}>Search:</label>
            <input
              type="text"
              placeholder="Search by product name or SKU..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
              style={{ width: '220px', padding: '12px 16px', border: 'none', borderRadius: '10px', boxShadow: '0 4px 15px rgba(0,0,0,0.1)', fontSize: '14px', background: 'rgba(255,255,255,0.9)' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <label style={{ fontWeight: '500', color: '#000', fontSize: '14px' }}>Show:</label>
            <select
              value={itemsPerPage}
              onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }}
              style={{ padding: '12px 16px', border: 'none', borderRadius: '10px', boxShadow: '0 4px 15px rgba(0,0,0,0.1)', fontSize: '14px', background: 'rgba(255,255,255,0.9)' }}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
            <span style={{ color: '#fff', fontWeight: '500' }}>per page</span>
          </div>
          <div style={{ marginLeft: 'auto', color: '#fff', fontWeight: '500', background: 'rgba(255,255,255,0.2)', padding: '8px 16px', borderRadius: '20px' }}>
            Showing {startIndex + 1}-{Math.min(startIndex + itemsPerPage, filteredVariants.length)} of {filteredVariants.length} variants
          </div>
        </div>
      </s-section>
      <s-section heading="Variant Table" style={{ textAlign: 'center', fontWeight: 'bold', background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', borderRadius: '12px', padding: '20px', boxShadow: '0 8px 32px rgba(0,0,0,0.1)' }}>
        {!variants || variants.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
            No variants found. Check console for debug info.
          </div>
        ) : (
        <div style={{ backgroundColor: '#fff', borderRadius: '16px', boxShadow: '0 10px 40px rgba(0,0,0,0.15)', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.2)', width: '100%' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', borderBottom: '2px solid #dee2e6' }}>
                <th style={{ padding: '18px', textAlign: 'left', fontWeight: '700', color: '#fff', fontSize: '14px' }}>Product</th>
                <th style={{ padding: '18px', textAlign: 'left', fontWeight: '700', color: '#fff', fontSize: '14px' }}>Variant</th>
                <th style={{ padding: '18px', textAlign: 'left', fontWeight: '700', color: '#fff', fontSize: '14px' }}>SKU</th>
                <th style={{ padding: '18px', textAlign: 'left', fontWeight: '700', color: '#fff', fontSize: '14px' }}>Original Price</th>
                <th style={{ padding: '18px', textAlign: 'left', fontWeight: '700', color: '#fff', fontSize: '14px' }}>Multiplier</th>
                <th style={{ padding: '18px', textAlign: 'left', fontWeight: '700', color: '#fff', fontSize: '14px' }}>New Price</th>
              </tr>
            </thead>
            <tbody>
              {paginatedVariants.map((variant, index) => {
              const hasMultiplier = multiplier[variant.id] && multiplier[variant.id] !== '';
              const originalPrice = originalPrices[variant.id] || variant.originalPrice;
              const newPrice = hasMultiplier ? (originalPrice * parseFloat(multiplier[variant.id])).toFixed(2) : null;
              
                return (
                  <tr key={variant.id} style={{ 
                    borderBottom: '1px solid #e9ecef', 
                    backgroundColor: index % 2 === 0 ? '#fff' : '#f8f9fa',
                    transition: 'background-color 0.2s ease'
                  }}
                  onMouseEnter={(e) => e.target.parentElement.style.backgroundColor = '#e3f2fd'}
                  onMouseLeave={(e) => e.target.parentElement.style.backgroundColor = index % 2 === 0 ? '#fff' : '#f8f9fa'}
                  >
                    <td style={{ padding: '16px', fontWeight: '600', color: '#212529' }}>{variant.productTitle}</td>
                    <td style={{ padding: '16px', color: '#495057' }}>{variant.title}</td>
                    <td style={{ padding: '16px', color: '#6c757d', fontFamily: 'monospace' }}>{variant.sku || "—"}</td>
                    <td style={{ padding: '16px' }}>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={originalPrice.toFixed(2)}
                        onChange={(event) => handleOriginalPriceChange(variant.id, event.target.value)}
                        style={{ 
                          width: '80px', 
                          padding: '8px 12px', 
                          border: '2px solid #dee2e6',
                          borderRadius: '10px', 
                          fontSize: '14px',
                          transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                          outline: 'none'
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor = '#007bff';
                          e.target.style.boxShadow = '0 0 0 3px rgba(0,123,255,0.1)';
                        }}
                        onBlur={(e) => {
                          e.target.style.borderColor = '#dee2e6';
                          e.target.style.boxShadow = 'none';
                        }}
                      />
                    </td>
                    <td style={{ padding: '16px' }}>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="Enter Value"
                        value={multiplier[variant.id] || ""}
                        onChange={(event) => handleChange(variant.id, event.target.value)}
                        style={{ 
                          width: '100px', 
                          padding: '8px 12px', 
                          border: '2px solid #dee2e6',
                          borderRadius: '10px', 
                          fontSize: '14px',
                          transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                          outline: 'none'
                        }}
                        onFocus={(e) => {
                          e.target.style.borderColor = '#007bff';
                          e.target.style.boxShadow = '0 0 0 3px rgba(0,123,255,0.1)';
                        }}
                        onBlur={(e) => {
                          e.target.style.borderColor = '#dee2e6';
                          e.target.style.boxShadow = 'none';
                        }}
                      />
                    </td>
                    <td style={{ 
                      padding: '16px', 
                      fontWeight: hasMultiplier ? '600' : '500',
                      color: hasMultiplier ? '#28a745' : '#495057',
                      fontSize: hasMultiplier ? '16px' : '14px'
                    }}>
                      {hasMultiplier ? `$${newPrice}` : currentPricesFromDB[variant.id] ? `$${parseFloat(currentPricesFromDB[variant.id]).toFixed(2)}` : `$${variant.price.toFixed(2)}`}
                    </td>
                  </tr>
                );
            })}
            </tbody>
          </table>
        </div>
        )}
        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ marginTop: '24px' }}>
            <div style={{ textAlign: 'center', marginBottom: '12px' }}>
              <label style={{ fontWeight: 'bold', color: '#fff', fontSize: '16px' }}>Pagination:</label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage === 1}
              style={{
                padding: '8px 12px',
                border: '1px solid #dee2e6',
                borderRadius: '6px',
                backgroundColor: currentPage === 1 ? '#f8f9fa' : '#fff',
                color: currentPage === 1 ? '#6c757d' : '#495057',
                cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                if (currentPage !== 1) {
                  e.target.style.backgroundColor = '#e9ecef';
                }
              }}
              onMouseLeave={(e) => {
                if (currentPage !== 1) {
                  e.target.style.backgroundColor = '#fff';
                }
              }}
            >
              Previous
            </button>
            
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let startPage = Math.max(1, currentPage - 2);
              let endPage = Math.min(totalPages, startPage + 4);
              if (endPage - startPage < 4) {
                startPage = Math.max(1, endPage - 4);
              }
              const pageNum = startPage + i;
              
              if (pageNum > totalPages) return null;
              
              return (
                <button
                  key={pageNum}
                  onClick={() => goToPage(pageNum)}
                  style={{
                    padding: '8px 12px',
                    border: '1px solid #dee2e6',
                    borderRadius: '6px',
                    backgroundColor: currentPage === pageNum ? '#007bff' : '#fff',
                    color: currentPage === pageNum ? '#fff' : '#495057',
                    cursor: 'pointer',
                    fontWeight: currentPage === pageNum ? '600' : '400',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    if (currentPage !== pageNum) {
                      e.target.style.backgroundColor = '#e9ecef';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (currentPage !== pageNum) {
                      e.target.style.backgroundColor = '#fff';
                    }
                  }}
                >
                  {pageNum}
                </button>
              );
            }).filter(Boolean)}
            
            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage === totalPages}
              style={{
                padding: '8px 12px',
                border: '1px solid #dee2e6',
                borderRadius: '6px',
                backgroundColor: currentPage === totalPages ? '#f8f9fa' : '#fff',
                color: currentPage === totalPages ? '#6c757d' : '#495057',
                cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => {
                if (currentPage !== totalPages) {
                  e.target.style.backgroundColor = '#e9ecef';
                }
              }}
              onMouseLeave={(e) => {
                if (currentPage !== totalPages) {
                  e.target.style.backgroundColor = '#fff';
                }
              }}
            >
              Next
            </button>
            </div>
          </div>
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