#!/usr/bin/env python3
"""生成一批干净逼真的样例会话/订单，供 demo 后台展示（漏斗+KPI 有意义的数字）。
输出 /tmp/seed_sessions.json 和 /tmp/seed_orders.json。

两个参数都可以不带，不带时输出与原来相同：
  --scenario console-ux  后台 UX 走查用的场景（docs/features/console-ux/spec.md 验收 4「走查种子与时钟」、
                         design-system.md §10.0 的会话表）：同样 13 个会话，A01 改成转人工，
                         各会话的最后动静按那张表相对 --now 定位，「昨天21:40」这类按 --now 所在时区的日历日算
  --scenario console-ux-02  02 spec 验收 33 走查用的场景（design-system.md §10.0 修正 5）：与 console-ux 同样
                         13 个会话、同样的时间定位，另外 A01 由「等人接手」改成「顾问处理中」（接手人小林），
                         F01 补一条转人工原因「客户投诉价格太贵」。7F3A（14 个会话里的第 14 个）不在这里，由
                         走查脚本经假企微接口和脚本化的 mock LLM 真跑出来
  --now 2026-09-26T14:30+08:00  钉住「现在」（ISO 8601，不带时区按本机时区）；不带时取当前时间"""
import argparse, json, time, sys
from datetime import date, datetime, timedelta, time as clock

ap = argparse.ArgumentParser(description="生成 demo 后台的样例会话与订单")
ap.add_argument("--scenario", choices=["default", "console-ux", "console-ux-02"], default="default", help="场景，默认 default")
ap.add_argument("--now", help="钉住现在，如 2026-09-26T14:30+08:00")
args = ap.parse_args()
now_dt = datetime.fromisoformat(args.now) if args.now else datetime.now()
if now_dt.tzinfo is None:
    now_dt = now_dt.astimezone()  # 不带时区的按本机时区；带了的保留，日历日按 --now 自己的时区算
now = int(now_dt.timestamp() * 1000) if args.now else int(time.time() * 1000)
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


def at_day(days_before, hh, mm):
    """--now 所在时区里、往前数 days_before 个日历日的 hh:mm（毫秒）"""
    d: date = now_dt.date() - timedelta(days=days_before)
    return int(datetime.combine(d, clock(hh, mm), tzinfo=now_dt.tzinfo).timestamp() * 1000)


def retime(s, updated_at):
    """把会话挪到最后动静 = updated_at：消息仍是每分钟一条，最后一条之后 1 分钟是 updatedAt（和 sess() 的写法一样）"""
    created = updated_at - len(s["messages"]) * 60000
    for i, m in enumerate(s["messages"]):
        m["at"] = created + i * 60000
    s["createdAt"], s["updatedAt"] = created, updated_at


if args.scenario in ("console-ux", "console-ux-02"):
    M = 60000
    # design-system.md §10.0 的会话表：F01、A01 等人接手；B01 到 D01 是今天；D02、D03 昨天；E01–E04 与 A02 前天（9月24日）
    last = {
        "wecom:cust_F01": now - 8 * M,
        "wecom:cust_A01": now - 26 * M,
        "wecom:cust_B01": now - 1 * H,
        "wecom:cust_C01": now - 2 * H,
        "wecom:cust_C02": now - 3 * H,
        "wecom:cust_D01": now - 5 * H,
        "wecom:cust_D02": at_day(1, 21, 40),
        "wecom:cust_D03": at_day(1, 16, 5),
        "wecom:cust_E01": at_day(2, 19, 25),
        "wecom:cust_E02": at_day(2, 16, 50),
        "wecom:cust_E03": at_day(2, 14, 35),
        "wecom:cust_E04": at_day(2, 12, 10),
        "wecom:cust_A02": at_day(2, 17, 20),
    }
    assert sorted(last) == sorted(s["id"] for s in S), "会话表与默认场景的会话对不上"
    for s in S:
        if s["id"] == "wecom:cust_A01":
            s["stage"], s["handedOver"] = "handoff", True
            if args.scenario == "console-ux-02":
                # §10.0 修正 5：A01 是「顾问处理中」，接手人小林（不是「等人接手」）。userId 只是本次走查
                # 种子用的占位短名，不对应真实账号——assignee 存在于 state JSONB 里，没有外键约束，
                # 展示（接手人姓名、「交还」按钮因不是本人而禁用）只看 userId 是否非空、是否等于当前登录者
                s["assignee"] = {"userId": "seed-xiaolin", "name": "小林", "at": last[s["id"]]}
                s["handoff"] = {"kind": "agent", "at": last[s["id"]], "reason": "顾问在工作台接手"}
        elif s["id"] == "wecom:cust_F01" and args.scenario == "console-ux-02":
            # §10.0 修正 5：F01 的转人工原因「客户投诉价格太贵」
            s["handoff"] = {
                "kind": "complaint",
                "at": last[s["id"]],
                "reason": "客户投诉价格太贵",
                "quote": "这个太贵了，我要投诉",
            }
        elif s["id"] == "wecom:cust_A02" and args.scenario == "console-ux-02":
            # 验收 33 要求种子里含一条「已成交客户要人工」（R9 paidNeedsHuman：终态 + handedOver + 没有接手人，
            # stage 仍是 paid，不进「等人接手」页签，只在 A2「需要你处理」与铃铛弹层单列一组）。
            # design-system §10.0 的基础 13 个会话没有这一条，这是 02 走查专门加的
            s["messages"] = [*s["messages"], {"role": "customer", "content": "我们这次出发日期想往后挪两天，麻烦帮我转人工改一下", "at": 0}]
            s["handedOver"] = True
            s["handoff"] = {
                "kind": "request",
                "at": last[s["id"]] + 10 * M,
                "reason": "已成交客户想改行程，要找顾问",
                "quote": "我们这次出发日期想往后挪两天，麻烦帮我转人工改一下",
            }
        elif s["id"] == "wecom:cust_D02" and args.scenario == "console-ux-02":
            # 验收 33 要求种子里含一条「紧急」转人工（R15：高把握的紧急情况，立即转人工、这一轮不调模型）。
            # design-system §10.0 的基础 13 个会话没有这一条，这是 02 走查专门加的；原本 D02 是「推荐」阶段，
            # 这里改写成客户在行程中遇到紧急情况，stage 改成 handoff、不进漏斗
            s["stage"], s["handedOver"] = "handoff", True
            s["messages"] = [
                {"role": "customer", "content": "我们现在在三亚玩，一个人突然喘不上气，脸都白了，怎么办", "at": 0},
                {"role": "agent", "content": "情况紧急！我们马上为您转接资深顾问，顾问会立即联系您协助处理，请尽快就近就医～", "at": 0},
            ]
            s["handoff"] = {
                "kind": "emergency",
                "at": last[s["id"]],
                "reason": "客户遇到紧急情况",
                "quote": "我们现在在三亚玩，一个人突然喘不上气，脸都白了，怎么办",
            }
        retime(s, last[s["id"]])
    created = {s["id"]: s["createdAt"] for s in S}
    for o in O:
        o["createdAt"] = created[o["sessionId"]]
        if "paidAt" in o:
            o["paidAt"] = o["createdAt"] + 8 * M

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
