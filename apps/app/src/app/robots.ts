import type { MetadataRoute } from "next";
import { PUBLIC_PRODUCT } from "@/lib/public-product";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: ["/", "/about"], disallow: ["/app/", "/api/", "/auth/", "/onboarding", "/media/", "/external-media/"] }, sitemap: `${PUBLIC_PRODUCT.site}/sitemap.xml` };
}
