// function calling 的工具定义（JSON Schema），纯数据、无副作用（01 spec「模块与依赖方向」）。
// 实现在 tools.ts，它再导出这里的 toolDefs。请求前缀里的 tools 就是 JSON.stringify(toolDefs)：
// 这份数据改一个字节，前缀缓存全部失效，tools_hash 也跟着变（启动时会生成一个 rerender 版本）。
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const toolDefs: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_routes',
      description:
        '搜索旅游线路，返回最多 3 条摘要。客户没说具体目的地、只描述了感受或场景时' +
        '（如「不用倒时差、带娃能玩水」「想找个安静的地方过纪念日」），把客户原话放进 query 做语义检索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '客户对需求的自然语言描述，用于语义检索；没有明确目的地时优先用这个' },
          destination: { type: 'string', description: '目的地关键词，如 马尔代夫、瑞士' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 蜜月、亲子、海岛' },
          segment: {
            type: 'string',
            enum: ['家庭', '亲子', '蜜月', '商务', '银发'],
            description:
              '客群。客户透露了同行人构成就一定要带上——带孩子=亲子、带爸妈/长辈=银发、' +
              '蜜月/新婚=蜜月、公司团建或接待客户=商务、多代同行=家庭。客户没提就不传，别按目的地或人数去猜。' +
              '银发会自动排除高海拔和长途颠簸的线路，亲子会优先有孩子玩点的线路。',
          },
          maxBudgetPerPerson: { type: 'number', description: '每人预算上限（元），只填客户自己说过的数；客户没说预算就不传' },
          days: { type: 'number', description: '期望行程天数（±2 天内算匹配）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_route_detail',
      description:
        '按线路 id 获取完整线路信息：逐日行程、住宿、费用含与不含、最高海拔。' +
        '客户问细节（几点、住哪、含不含、保险、走路爬山累不累、海拔、第几天）先调它，只按返回的原文回答。',
      parameters: {
        type: 'object',
        properties: { routeId: { type: 'string' } },
        required: ['routeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_hotels',
      description: '按目的地/标签/预算搜索精品酒店，返回最多 3 家。客户单独问酒店、或想在某目的地挑酒店时用。',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: '目的地关键词，如 马尔代夫、日本' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 蜜月、亲子、一价全包' },
          maxNightlyPrice: { type: 'number', description: '每晚预算上限（元）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_quote',
      description: '生成正式报价。报价必须来自本工具，不得自行编造价格。',
      parameters: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          travelers: { type: 'number', description: '出行人数' },
          departDate: {
            type: 'string',
            description: '出发日期 YYYY-MM-DD。客户说过出发时间（含国庆、五一这类节假日）就带上，旺季价按它算',
          },
        },
        required: ['routeId', 'travelers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_proposal',
      description:
        '生成正式行程方案书（逐日行程 + 住宿 + 含餐 + 费用含/不含 + 报价），返回可发给客户的方案链接。' +
        '客户想看详细安排时调用——**包括他第一句话就要「详细方案/详细行程」的情况**：' +
        '先用 search_routes 拿到 routeId，同一轮接着调本工具，不必等到下一轮；' +
        '会话状态里「最近查到的线路」已列出这条线的 id 时直接用，不必重查。' +
        'travelers 用客户说过的人数（「两个人」=2）；departDate 客户说过出发时间（含国庆、五一这类节假日）就带上，' +
        '没说就不传，别为了凑参数专门去问。',
      parameters: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          travelers: { type: 'number', description: '出行人数' },
          departDate: { type: 'string', description: '出发日期 YYYY-MM-DD，可选' },
        },
        required: ['routeId', 'travelers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: '客户确认购买后创建订单，返回支付链接',
      parameters: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          travelers: { type: 'number' },
          departDate: { type: 'string', description: '出发日期 YYYY-MM-DD' },
        },
        required: ['routeId', 'travelers', 'departDate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff_to_human',
      description:
        '转接人工顾问。客户明确要求人工、投诉、退款或连续两轮无法理解时调用。' +
        '客户想去的地方我们没有现成线路时先别调：先推荐最接近的现成线路，客户坚持只要原目的地才调' +
        '（只是回答了出行时间、人数不算坚持），reason 里写清目的地、出行时间、人数。' +
        '付款链接打不开、要重发不用转人工。回复里说了「为您转接」就必须调本工具。转人工后你不会再回复这位客户。',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            // 实测模型把客户说的「明年2月」写成「2026年2月」（今天已是 2026 年 9 月，应为 2027），顾问照着就约错了年份
            description:
              '转人工原因，给接手的顾问看：目的地、出行时间、人数（没说的写「未知」）。' +
              '出行时间照客户原话写（客户说「明年2月」就写「明年2月」），不要自行换算成带年份的日期。',
          },
        },
        required: ['reason'],
      },
    },
  },
];
