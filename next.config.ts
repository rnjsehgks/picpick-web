import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 정적 사이트로 빌드 (Cloudflare Pages 호환)
  output: 'export',
  // Next.js Image 최적화 끄기 (정적 export에서 필수)
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
