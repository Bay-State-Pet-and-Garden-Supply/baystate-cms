import { canonicalizeUrl } from '../src/onboarding/image-utils';

const urls = [
  '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_1.png?v=1757965804&width=1200',
  '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_3_0a05886a-ca80-4ad5-834b-790a163c0916.png?v=1760192970&width=1200',
  '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_2_3d475097-c4e1-4baf-ae6f-7ec91ce9a6f9.png?v=1760192970&width=1200',
  '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_4_1.png?v=1760192969&width=1200',
  '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_5_5d6b501a-a3b0-4863-a9f4-c3704d9a8513.png?v=1760192969&width=1200',
  '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_6_a5f9138c-3904-48fc-b38e-f5f5c9ce74b8.png?v=1760192973&width=1200',
  '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_7_93782b85-600c-4833-b618-be3bfa248f20.png?v=1760192973&width=1200'
];

for (const url of urls) {
  console.log(url, '=>', canonicalizeUrl(url));
}
