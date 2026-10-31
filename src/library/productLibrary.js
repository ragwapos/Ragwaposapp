// Ready-made catalogue a new shop can import into its own products (see
// ProductLibraryModal in ../dashboard/TenantApp.jsx). Prices are starting
// points the shop edits before saving. Images live in public/product-library/
// and are copied into the shop's own storage folder on import.
const RUSH_IRON = "كوي مستعجل";
const RUSH_WASH_IRON = "غسيل وكوي مستعجل";
const IRON = "كوي";
const WASH_IRON = "غسيل وكوي";

const p = (category, name, image, services, addons = []) => ({ category, name, image, services, addons });
const rush = (iron, washIron) => [{ name: RUSH_IRON, price: iron }, { name: RUSH_WASH_IRON, price: washIron }];

export const PRODUCT_LIBRARY = [
  p("الملابس الرجالية والتقليدية", "ثوب", "thob.jpg", { [IRON]: 2, [WASH_IRON]: 3 }, rush(1, 2)),
  p("الملابس الرجالية والتقليدية", "شماغ", "shmagh.jpg", { [IRON]: 3, [WASH_IRON]: 3 }, rush(1, 2)),
  p("الملابس الرجالية والتقليدية", "طاقية", "taqiya.jpg", { [IRON]: 1, [WASH_IRON]: 2 }, rush(0, 1)),
  p("الملابس الرجالية والتقليدية", "مشلح", "mishlah.jpg", { [IRON]: 10, [WASH_IRON]: 15 }, rush(5, 5)),
  p("الملابس الرجالية والتقليدية", "إحرام", "ihram.jpg", { [IRON]: 3, [WASH_IRON]: 5 }, rush(1, 4)),

  p("الملابس النسائية", "عباية", "abaya.jpg", { [IRON]: 5, [WASH_IRON]: 10 }, rush(3, 5)),
  p("الملابس النسائية", "مريول", "mariool.jpg", { [IRON]: 3, [WASH_IRON]: 4 }, rush(0, 2)),

  p("الملابس العامة والبدلات", "بنطلون", "pants.png", { [IRON]: 2, [WASH_IRON]: 3 }, rush(0, 3)),
  p("الملابس العامة والبدلات", "جاكيت", "jacket.jpg", { [IRON]: 3, [WASH_IRON]: 5 }, rush(2, 3)),
  p("الملابس العامة والبدلات", "بالطو", "coat.jpg", { [IRON]: 3, [WASH_IRON]: 5 }, rush(1, 3)),
  p("الملابس العامة والبدلات", "بدلة رياضية", "tracksuit.jpg", { [IRON]: 2, [WASH_IRON]: 3 }, rush(0, 3)),
  p("الملابس العامة والبدلات", "بدله باكستاني", "pakistani.png", { [IRON]: 4, [WASH_IRON]: 7 }, rush(1, 3)),
  p("الملابس العامة والبدلات", "بدله عسكرية", "military.jpg", { [IRON]: 4, [WASH_IRON]: 6 }, rush(2, 4)),
  p("الملابس العامة والبدلات", "فرهول", "overall.jpg", { [IRON]: 3, [WASH_IRON]: 5 }, rush(1, 3)),
  p("الملابس العامة والبدلات", "قبوع", "qabou.jpg", { [IRON]: 1, [WASH_IRON]: 2 }, rush(0, 1)),

  p("الملابس الداخلية واليومية", "سروال طويل", "sirwal_long.jpg", { [IRON]: 1, [WASH_IRON]: 2 }, rush(1, 1)),
  p("الملابس الداخلية واليومية", "سروال قصير", "sirwal_short.jpg", { [IRON]: 1, [WASH_IRON]: 2 }, rush(1, 1)),
  p("الملابس الداخلية واليومية", "فنيلة", "fanila.jpg", { [IRON]: 1, [WASH_IRON]: 2 }, rush(1, 1)),
  p("الملابس الداخلية واليومية", "شراب", "sharab.jpg", { [IRON]: 1, [WASH_IRON]: 2 }, rush(0, 1)),

  p("مفارش وأغطية النوم", "شرشف خفيف", "sheet_light.jpg", { [IRON]: 3, [WASH_IRON]: 5 }, rush(2, 3)),
  p("مفارش وأغطية النوم", "شرشف ثقيل", "sheet_heavy.jpg", { [IRON]: 7, [WASH_IRON]: 10 }, rush(3, 5)),
  p("مفارش وأغطية النوم", "بيت مخدة", "pillowcase.png", { [IRON]: 1, [WASH_IRON]: 6 }, rush(0, 0)),
  p("مفارش وأغطية النوم", "مخدة", "pillow.jpg", { [WASH_IRON]: 5 }, [{ name: RUSH_WASH_IRON, price: 3 }]),
  p("مفارش وأغطية النوم", "بطانية نفر", "blanket1.jpg", { [WASH_IRON]: 20 }, [{ name: RUSH_WASH_IRON, price: 10 }]),
  p("مفارش وأغطية النوم", "بطانية نفرين", "blanket2.jpg", { [WASH_IRON]: 25 }, [{ name: RUSH_WASH_IRON, price: 10 }]),
  p("مفارش وأغطية النوم", "لحاف نفر", "duvet1.jpg", { [WASH_IRON]: 20 }, [{ name: RUSH_WASH_IRON, price: 10 }]),
  p("مفارش وأغطية النوم", "لحاف نفرين", "duvet2.jpg", { [WASH_IRON]: 25 }, [{ name: RUSH_WASH_IRON, price: 10 }]),

  p("المفروشات والمستلزمات المنزلية", "ستارة", "curtain.jpg", { [IRON]: 7, [WASH_IRON]: 10 }, rush(3, 5)),
  p("المفروشات والمستلزمات المنزلية", "سجاد", "carpet.jpg", { [WASH_IRON]: 8 }),
  p("المفروشات والمستلزمات المنزلية", "منشفة", "towel.jpg", { [IRON]: 3, [WASH_IRON]: 5 }, rush(1, 3)),
];

export const libraryImageUrl = (image) => `/product-library/${image}`;
