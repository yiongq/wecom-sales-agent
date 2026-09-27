# ADR-004：产品库表单由行业包的字段配置渲染

- **状态**：采纳（owner 2026-09-27，随后台 UX spec 翻 ready 一并确认）
- **日期**：2026-09-27
- **取代**：[ADR-002](adr-002-console-vite-react.md) 决策 1 里「产品库表单由行业包的 zod schema 转成 JSON Schema 自动生成」这一条。ADR-002 的其余决策不变。
- **背景**：01 按 ADR-002 用 `z.toJSONSchema` 把 `RouteSchema` / `HotelSchema` 转成 JSON Schema，再由 rjsf 在抽屉里生成表单。审查和走查指出几个问题：
  - 字段标签是英文键，必填项一排红星，锁定字段用禁用样式显示，读起来像「坏了」。
  - JSON Schema 表达不了界面需要的信息：中文标签与帮助、单位、锁定分组和锁定原因、列表列与筛选、上架前检查的建议项、月份区间和逐日行程这类专门的编辑方式。
  - rjsf 默认的校验器 ajv 要 `new Function`，被 CSP 拦下，01 只好另写 zod 校验器接进去；rjsf 本身也占了首屏包的一块。
  - 产品化以后一个后台要服务多个行业包（[后台 UX spec](../features/console-ux/spec.md)「行业包通用架构」）。标签、单位、锁定原因这些都得随行业包走，放进 rjsf 的 uiSchema 等于另写一份配置。

---

## 决策

1. **行业包提供字段配置。** 每个包给出一份 `IndustryPack`（`src/shared/pack.ts`）：实体、字段（`FieldDef`：键路径、类型、中文标签、分组、帮助、必填、锁定分组、按类型的配置项）、销售阶段、话术节表、词汇和导航。旅游包在 `src/packs/travel/`，注册表在 `src/packs/registry.ts`。
2. **console 按字段类型渲染。** `FieldType` 是固定的一组：`text`、`longText`、`money`、`intUnit`、`monthRange`、`enum`、`tags`、`boolean`、`subItems`、`reference`、`status`。每种类型一个渲染器，各有列表单元格、表单、只读三种形态；渲染器表的类型是 `Record<FieldType, …>`，少一种 typecheck 就报错。
3. **配置经接口下发。** console 启动时取 `GET /api/console/pack`，不 import 任何行业包模块，由 `scripts/check-boundaries.ts` 检查（渲染器自测是唯一例外）。
4. **校验仍以行业包的 zod schema 为准。** 服务端照旧用 `RouteSchema` / `HotelSchema` 校验写入；界面的「上架前检查」由共享的 `checkItem` 按字段配置计算。字段配置与 schema 的对应关系由自测逐项核对，两边对不上 `pnpm test` 失败。
5. **去掉 `@rjsf/*`。**

新增一个行业，只需要写它的 zod schema 和字段配置，`console/src/` 零改动。新增字段类型要改 console：字段类型是界面和行业包之间的契约。

## 理由

- 目的和 ADR-002 那一条相同：新行业不写新表单。换一种手段是为了把界面需要、而 JSON Schema 带不了的信息，放进一份行业包自己维护的配置里。
- 按类型渲染，全站同一种字段长得一样、行为一样，也便于统一做对比度、只读样式和校验文案。

## 被否决的方案

- **保留 rjsf，写自定义 widget 和 template**：标签、锁定原因、分组仍要写进每个包的 uiSchema，相当于两份配置；ajv 与 CSP 的冲突还在；包体积不降。
- **每个实体手写 antd 表单**：每接一个行业都要改 console，违背「一套后台服务所有行业包」。
- **引入通用表单引擎（如 Formily）**：多一套运行时和 DSL，字段种类其实只有十一种，自己写渲染器更轻，也更好控制样式和可访问性。

## 后果

- 要写十一种渲染器和一套字段配置，并用自测保证字段配置与 zod schema 一致。
- 01 spec「后台 API 与页面」的表单条款已在 2026-09-27 就地修订为能力级写法（「表单由产品类型的定义生成，不为每种类型手写」），与本决策一致。
- 实施步骤见 [后台 UX plan](../features/console-ux/plan.md) 第 3 步。
