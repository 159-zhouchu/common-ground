import type { Store, Task, Review } from './types';
export const now = () => new Date().toISOString();
export function seed(): Store {
  const createdAt = now();
  const task: Task = {
    id: 'example-campus',
    title: '校园低碳行动 · 项目方案',
    description: '从一份方案开始，让每一次修改都有据可查。',
    goal: '评审项目预算、实施安排与材料是否一致，保留已经确定的活动目标。',
    example: true,
    currentRevision: 'example-v1',
    createdAt,
    updatedAt: createdAt,
    sources: [
      {
        id: 'quote',
        name: '物料采购报价.txt',
        version: 1,
        kind: 'original',
        createdAt,
        text: '【合成示例材料，非真实报价】\n宣传册：40 份，每份未税单价 50 元；税率 13%。\n统一配送费 250 元，无其他费用。\n印刷制作周期：确认稿件后 5 个工作日。',
      },
      {
        id: 'schedule',
        name: '活动执行说明.txt',
        version: 1,
        kind: 'original',
        createdAt,
        text: '【合成示例材料】\n活动时间：11 月 13 日。\n宣传册稿件在 11 月 10 日周二确认。\n印刷供应商自确认稿件的次日起计算 5 个工作日，周末不计；不含额外物流时间。\n雨天改在学生中心一层大厅开展，场地已获许可。\n活动反馈由两名志愿者现场匿名收集，禁止采集姓名和手机号。',
      },
    ],
    revisions: [
      {
        id: 'example-v1',
        number: 1,
        title: '校园低碳行动 · 项目方案',
        constraint: '项目预算不超过 3000 元；不采集参与者个人身份信息。',
        createdAt,
        reason: '初始方案 · 合成演示',
        blocks: [
          {
            id: 'overview',
            title: '01  项目概述',
            origin: 'user',
            content:
              '以一次校园低碳行动，连接日常选择与可持续生活。项目通过现场展览、轻量互动和行动卡片，鼓励同学从身边的小事开始。\n\n活动拟于 11 月 13 日开展，面向全校同学开放。',
          },
          {
            id: 'budget',
            title: '02  物料与预算',
            origin: 'user',
            content:
              '宣传册 40 份 × 50 元 = 2000 元。\n税费按 13% 计 60 元；统一配送费 250 元。\n项目总额 2310 元，低于 3000 元预算上限。',
          },
          {
            id: 'plan',
            title: '03  实施安排',
            origin: 'user',
            content:
              '11 月 10 日确认宣传册稿件，11 月 13 日活动开始前完成全部物料交付。两名志愿者负责布展与现场引导。\n\n雨天改为线上活动，参与者通过问卷填写姓名和手机号，以便后续联系。',
          },
          {
            id: 'outcome',
            title: '04  预期成果',
            origin: 'user',
            content:
              '形成一份低碳行动倡议和一组匿名参与反馈，将活动经验整理成可复用的组织手册。项目效果以实际参与和反馈记录评估，不提前承诺减排数量。',
          },
        ],
      },
    ],
    findings: [],
    messages: [],
    runs: [],
    impacts: [],
  };
  return { version: 1, tasks: [task] };
}
export function exampleReview(): Review {
  return {
    summary:
      '发现 3 处值得处理的问题：预算计算、印刷交付安排，以及雨天预案和信息收集方式。请先核对原文，再选择采用修改。',
    questions: ['调整预算或活动日期后，请重新检查相关费用和实施安排。'],
    findings: [
      {
        title: '税费及预算总额计算不一致',
        kind: '计算错误',
        severity: 'high',
        blockId: 'budget',
        before:
          '税费按 13% 计 60 元；统一配送费 250 元。\n项目总额 2310 元，低于 3000 元预算上限。',
        after:
          '税费按 13% 计 260 元；统一配送费 250 元。\n项目总额 2510 元，低于 3000 元预算上限。',
        reason: '2000 × 13% = 260，2000 + 260 + 250 = 2510。修正计算后仍在预算内。',
        sourceId: 'quote',
        quote: '宣传册：40 份，每份未税单价 50 元；税率 13%。',
        relation: 'contradicts',
      },
      {
        title: '印刷周期无法支持当前交付安排',
        kind: '时间约束',
        severity: 'high',
        blockId: 'plan',
        before: '11 月 10 日确认宣传册稿件，11 月 13 日活动开始前完成全部物料交付。',
        after:
          '当前印刷周期无法支持 11 月 13 日前交付；需与供应商确认加急可行性，或提前确认稿件、调整活动日期后再确定交付安排。',
        reason:
          '制作需要自确认次日起 5 个工作日，当前时间窗口不足；没有加急承诺，不能直接假定按时交付。',
        sourceId: 'schedule',
        quote: '印刷供应商自确认稿件的次日起计算 5 个工作日，周末不计；不含额外物流时间。',
        relation: 'contradicts',
      },
      {
        title: '雨天预案与隐私约束需同步修订',
        kind: '材料矛盾',
        severity: 'medium',
        blockId: 'plan',
        before: '雨天改为线上活动，参与者通过问卷填写姓名和手机号，以便后续联系。',
        after: '雨天改在学生中心一层大厅开展。由两名志愿者现场匿名收集反馈，不采集姓名和手机号。',
        reason: '执行说明已确认室内场地，并明确匿名反馈要求；当前方案同时遗漏了两项约束。',
        sourceId: 'schedule',
        quote: '活动反馈由两名志愿者现场匿名收集，禁止采集姓名和手机号。',
        relation: 'contradicts',
      },
    ],
  };
}
