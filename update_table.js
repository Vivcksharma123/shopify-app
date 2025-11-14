import mysql from 'mysql2/promise';

async function updateTable() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'shopify_app'
  });

  try {
    // Drop old table
    await connection.execute('DROP TABLE IF EXISTS variant_original_prices');
    
    // Create new table with both original and current price
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS variant_prices (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        variantId VARCHAR(191) NOT NULL UNIQUE,
        originalPrice DOUBLE NOT NULL,
        currentPrice DOUBLE NOT NULL,
        createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      )
    `);

    console.log('✅ Table updated successfully');
  } catch (error) {
    console.error('❌ Error updating table:', error);
  } finally {
    await connection.end();
  }
}

updateTable();