import mysql from 'mysql2/promise';

async function createTables() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'shopify_app'
  });

  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        shop VARCHAR(191) NOT NULL,
        state VARCHAR(191) NOT NULL,
        isOnline BOOLEAN NOT NULL DEFAULT false,
        scope VARCHAR(191),
        expires DATETIME(3),
        accessToken VARCHAR(191) NOT NULL,
        userId BIGINT,
        firstName VARCHAR(191),
        lastName VARCHAR(191),
        email VARCHAR(191),
        accountOwner BOOLEAN NOT NULL DEFAULT false,
        locale VARCHAR(191),
        collaborator BOOLEAN DEFAULT false,
        emailVerified BOOLEAN DEFAULT false
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS variant_original_prices (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        variantId VARCHAR(191) NOT NULL UNIQUE,
        price DOUBLE NOT NULL,
        createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      )
    `);

    console.log('✅ Tables created successfully');
  } catch (error) {
    console.error('❌ Error creating tables:', error);
  } finally {
    await connection.end();
  }
}

createTables();