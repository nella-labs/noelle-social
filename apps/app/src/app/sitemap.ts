import type { MetadataRoute } from "next";
import { PUBLIC_PRODUCT } from "@/lib/public-product";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${PUBLIC_PRODUCT.site}/about`, changeFrequency: "monthly", priority: 1 }];
}
