#!/usr/bin/env python3
"""生成一批干净逼真的样例会话/订单，供 demo 后台展示（漏斗+KPI 有意义的数字）。
输出 /tmp/seed_sessions.json 和 /tmp/seed_orders.json。"""
import json, time, sys
now = int(time.time() * 1000)
H = 3600 * 1000


def sess(sid, stage, prof, msgs, handed=False, order_ids=None, age_h=2):
    created = now - int(age_h * H)
    return {
        "id": sid, "channel": "wecom", "stage": stage, "profile": prof,
        "messages": [{"role": r, "content": c, "at": created + i * 60000} for i, (r, c) in enumerate(msgs)],
        "orderIds": order_ids or [], "handedOver": handed,
        "createdAt": created, "updatedAt": created + len(msgs) * 60000,
    }


def order(oid, sid, rid, title, trav, date, total, status, age_h=2):
    created = now - int(age_h * H)
    o = {"id": oid, "sessionId": sid, "routeId": rid, "routeTitle": title,
         "travelers": trav, "departDate": date, "totalPrice": total,
         "status": status, "createdAt": created}
    if status == "paid":
        o["paidAt"] = created + 8 * 60000
    return o


S, O = [], []

# 成交 ×2
S.append(sess("wecom:cust_A01", "paid",
    {"nickname": "Cici陈", "destinationInterest": "马尔代夫", "travelers": "2人", "dates": "2026-10-15", "budget": "每人6万"},
    [("customer", "你好，想去马尔代夫蜜月，两个人"),
     ("agent", "太棒了，马尔代夫是蜜月首选！给您推荐 Soneva Jani 蜜月 6 日，水上别墅可开顶观星～大概什么时候出发？"),
     ("customer", "预算每人6万，10月15号出发"),
     ("agent", "给您报个价：Soneva Jani 蜜月 6 日，每人 52,800，2 人共 105,600 元。可以吗？"),
     ("customer", "就订这个"),
     ("agent", "已为您锁定名额，请点链接完成支付～"),
     ("agent", "已收到您的支付，太开心啦！顾问稍后对接行程细节～")],
    order_ids=["ord_seed_A01"], age_h=4))
O.append(order("ord_seed_A01", "wecom:cust_A01", "r-maldives", "马尔代夫 Soneva Jani 蜜月 6 日", 2, "2026-10-15", 105600, "paid", age_h=4))

S.append(sess("wecom:cust_A02", "paid",
    {"nickname": "王姐", "destinationInterest": "日本", "travelers": "4人", "dates": "2026-09-20", "budget": "每人3万"},
    [("customer", "一家四口想去日本，两个大人两个小孩"),
     ("agent", "亲子游好选择！日本迪士尼+环球双乐园 7 日很适合，孩子玩疯～"),
     ("customer", "9月20号出发，就定这个吧"),
     ("agent", "已下单，东京迪士尼·大阪环球 7 日，4 人共 101,840 元，请支付～"),
     ("agent", "已收到支付，感谢信任！行程确认书稍后发您～")],
    order_ids=["ord_seed_A02"], age_h=5))
O.append(order("ord_seed_A02", "wecom:cust_A02", "r-japan-family", "日本 东京迪士尼·大阪环球双乐园亲子7日", 4, "2026-09-20", 101840, "paid", age_h=5))

# 促成 ×1（待支付）
S.append(sess("wecom:cust_B01", "closing",
    {"nickname": "Momo酱", "destinationInterest": "巴厘岛", "travelers": "2人", "dates": "2026-11-10", "budget": "每人4万"},
    [("customer", "想去巴厘岛蜜月"),
     ("agent", "宝格丽悬崖蜜月 7 日了解一下？私人泳池俯瞰印度洋～"),
     ("customer", "11月10号，可以下单"),
     ("agent", "已为您生成订单，巴厘岛宝格丽 7 日，2 人共 85,600 元，请点链接支付～")],
    order_ids=["ord_seed_B01"], age_h=1))
O.append(order("ord_seed_B01", "wecom:cust_B01", "r-bali-lux", "巴厘岛 宝格丽·阿雅娜悬崖顶奢蜜月7日", 2, "2026-11-10", 85600, "pending_payment", age_h=1))

# 报价 ×2
S.append(sess("wecom:cust_C01", "quote",
    {"nickname": "李行舟", "destinationInterest": "瑞士", "travelers": "2人", "budget": "每人6万"},
    [("customer", "瑞士深度游有什么推荐"),
     ("agent", "冰川快车全景环线 9 日，穿行阿尔卑斯～"),
     ("customer", "两个人多少钱"),
     ("agent", "每人 62,800，2 人共 125,600 元。要不要帮您留位？")], age_h=3))
S.append(sess("wecom:cust_C02", "quote",
    {"nickname": "Summer", "destinationInterest": "北欧极光", "travelers": "2人", "dates": "2026-12-05"},
    [("customer", "想去看极光"),
     ("agent", "芬兰玻璃屋 8 日，躺床上看极光划过夜空～"),
     ("customer", "12月初，报个价"),
     ("agent", "每人 46,800，2 人共 93,600 元～")], age_h=5))

# 推荐 ×3
S.append(sess("wecom:cust_D01", "recommend", {"nickname": "赵一帆", "destinationInterest": "迪拜", "travelers": "3人"},
    [("customer", "迪拜适合带老人孩子吗"),
     ("agent", "很适合！棕榈岛亚特兰蒂斯水世界家庭乐园 6 日，老少皆宜～几位出行？")], age_h=2))
S.append(sess("wecom:cust_D02", "recommend", {"nickname": "橙子", "destinationInterest": "三亚"},
    [("customer", "春节想去三亚"),
     ("agent", "三亚亲子奢华度假 5 日，亚特兰蒂斯水世界+柏悦连住～大概几位？")], age_h=4))
S.append(sess("wecom:cust_D03", "recommend", {"nickname": "Anna何", "destinationInterest": "新西兰", "travelers": "2人"},
    [("customer", "新西兰南岛"),
     ("agent", "南岛峡湾与星空 10 日，皇后镇+米尔福德峡湾～蜜月还是家庭呢？")], age_h=3))

# 问需 ×4
disc = [
    ("你好", "您好！云途定制旅行顾问在此～最近想去哪儿放松呢？"),
    ("有什么好玩的推荐", "看您偏好啦～是想海岛度假、欧洲人文，还是极光探险？"),
    ("想带爸妈出去玩", "孝心之选！方便告诉我大概去哪个方向、几位长辈吗？"),
    ("最近想旅游", "好呀～这次是蜜月、亲子还是纯放松？想去国内还是出境？"),
]
for i, (txt, rep) in enumerate(disc):
    S.append(sess(f"wecom:cust_E0{i+1}", "discovery", {}, [("customer", txt), ("agent", rep)], age_h=1 + i))

# 转人工 ×1（单列，不进漏斗）
S.append(sess("wecom:cust_F01", "handoff", {"nickname": "刘倩", "destinationInterest": "马尔代夫", "travelers": "2人"},
    [("customer", "这个太贵了，我要投诉"),
     ("agent", "非常抱歉给您带来不好的体验 我马上为您转接资深顾问处理～")],
    handed=True, age_h=2))

json.dump(S, open("/tmp/seed_sessions.json", "w"), ensure_ascii=False, indent=2)
json.dump(O, open("/tmp/seed_orders.json", "w"), ensure_ascii=False, indent=2)

from collections import Counter
c = Counter(s["stage"] for s in S)
nonh = [s for s in S if s["stage"] != "handoff"]
rank = {"greeting": 0, "discovery": 1, "recommend": 2, "quote": 3, "objection": 4, "closing": 5, "paid": 6}
reached = lambda mr: sum(1 for s in nonh if rank[s["stage"]] >= mr)
print("阶段分布:", dict(c))
print(f"漏斗: 问需{reached(1)} → 推荐{reached(2)} → 报价{reached(3)} → 促成{reached(5)} → 成交{reached(6)}")
print(f"转人工(单列): {c['handoff']} | GMV: {sum(o['totalPrice'] for o in O if o['status']=='paid')} | 会话总数: {len(S)} | 订单: {len(O)}")
