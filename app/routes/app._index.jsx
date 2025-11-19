import { useEffect } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );
  const responseJson = await response.json();
  const product = responseJson.data.productCreate.product;
  const variantId = product.variants.edges[0].node.id;
  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyReactRouterTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );
  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson.data.productCreate.product,
    variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
  };
};

export default function Index() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.product?.id) {
      shopify.toast.show("Product created");
    }
  }, [fetcher.data?.product?.id, shopify]);
  const generateProduct = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="Variation Price Multiplier">
      <s-section heading="App Description">
        <s-paragraph>
          Variation Price Multiplier is a lightweight Shopify admin-only tool designed for merchants who need to quickly calculate adjusted prices for all product variations using a custom multiplier value.
          This app is perfect for stores that manage large catalogs and need an efficient way to compute bulk pricing calculations without affecting the storefront.
        </s-paragraph>
      </s-section>

      <s-section heading="Key Features">
        <s-stack direction="block" gap="base">
        <s-unordered-list>
          <s-list-item>
            <s-text weight="bold">View All Product Variants in One Place</s-text>
            <s-paragraph>
              Display every variant of a selected product — including SKU, variant title, and base price — in a clean, organized list inside the Shopify admin.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text weight="bold">Apply a Custom Multiplier</s-text>
            <s-paragraph>
              Enter any input value (e.g., 1.2, 1.5, 3, etc.), and the app instantly calculates the updated price for each variant.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text weight="bold">Single "Update All" Button</s-text>
            <s-paragraph>
              With one click, update all variant prices using the multiplier. No need to adjust variants one by one.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text weight="bold">Backend-Only Tool</s-text>
            <s-paragraph>
              Your calculations and tools never appear on the storefront.
              Only visible to store admins through your private app interface.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text weight="bold">Lightweight & Fast</s-text>
            <s-paragraph>
              Built with Shopify Admin UI Extensions, the app loads quickly and works seamlessly without slowing down your theme.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text weight="bold">Perfect for Stores Using Bulk Pricing Rules</s-text>
            <s-paragraph>
              Ideal for merchants who adjust pricing based on:
            </s-paragraph>
            <s-box padding="base">
              <s-stack direction="inline" gap="base">
              <s-text size="medium">✓ Wholesale multipliers</s-text>
              <s-text size="medium">✓ Cost + margin formula</s-text>
              <s-text size="medium">✓ Bulk pricing updates</s-text>
              <s-text size="medium">✓ Custom markup calculations</s-text>
              <s-text size="medium">✓ Vendor-specific pricing rules</s-text>
            </s-stack>
            </s-box>
          </s-list-item>
        </s-unordered-list>
        </s-stack>
      </s-section>


    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
