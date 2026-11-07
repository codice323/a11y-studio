# 协作与交付

产品/前端维护 `apps/web` 和 `docs/UI_DESIGN.md`；检测与工程维护 `apps/api/import.ts`、`scan.ts`、`storage.ts` 与测试样例；AI 与集成维护 `repair.ts`、`knowledge/wcag`、报告与实验。共享协议为 `packages/shared/types.ts` 和 `docs/API.md`。

变更接口先更新协议；各模块合并前执行类型检查与测试；合并后验证导入、检测、审核、修复、复测、回滚、导出整条流程。实验指标采用真实扫描与验证记录，模型接口测试使用可识别的 mock 服务。
