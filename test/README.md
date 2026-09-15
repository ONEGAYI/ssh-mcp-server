# 测试文档

本项目使用 Node.js 内置的测试框架进行单元测试和集成测试；远端 helper 另有 Python 测试（`*.test.py`，需真实 Linux 环境的用例在无环境时自动跳过）。

## 测试结构

```text
test/
├── command-line-parser.test.js    # 命令行参数与 --config-file 解析
├── ssh-config-parser.test.js      # OpenSSH config 解析（Host 别名/Include/展开）
├── ssh-connection-manager.test.js # 连接管理、白名单/黑名单校验
├── ssh-input-command.test.js      # 输入命令白名单校验
├── explicit-ssh-args.test.js      # 显式 host/密钥参数模式
├── list-servers.test.js           # --list-servers 输出
├── cli-info-flags.test.js         # CLI 信息类旗标
├── integration.test.js            # 上游集成测试
├── lazy-dependencies.test.js      # 惰性依赖加载纪律
├── lifecycle.test.js              # 工作区 MCP 生命周期
├── workspace-config.test.js       # profile 加载、identity 派生与校验
├── workspace-mcp.test.js          # 工作区 MCP 契约（含 remote_help）
├── workspace-mcp-remote.test.js   # 工作区 MCP 与远端交互契约
├── workspace-write-schema.test.js # 写工具入参 schema
├── directory-scope.test.js        # restricted/unrestricted 目录边界
├── setup-mcp.test.js              # remote_setup configure/inspect/update 契约与 #31 迁移
├── setup-workspace.test.js        # 手工 CLI setup 入口
├── remove-binding.test.js         # 绑定移除契约（#28/#32/#33）
├── legacy-doc-generations.mjs     # 三代落盘文档契约快照（非测试，供引用）
├── recovery-hook.test.js          # 恢复钩子注入与离线纪律
├── job-cli.test.js                # job CLI 本地行为
├── job-cli-remote.test.js         # job CLI 与远端协议
├── task-service.test.js           # 本地任务登记/确认/pendingAcross
├── transfer-service.test.js       # 传输事务：断点续传、预算、恢复、pendingAcross
├── remote-agent-client.test.js    # SSH_MCP_V1 信封与传输客户端
├── space-ledger.test.js           # 本机空间额度账本
├── storage-report.test.js         # 空间用量报告
├── status-collector.test.js       # 状态汇总
├── maintenance-service.test.js    # 维护轮节流与互斥
├── largefile-acceptance.test.js   # 大文件扩展端到端验收（#6–#21）
├── test-runner.test.js            # 测试运行器自身
├── remote-agent.test.py           # 远端 helper：任务生命周期
├── remote-files.test.py           # 远端 helper：受保护文件操作
├── remote-transfer.test.py        # 远端 helper：传输事务
├── remote-ledger.test.py          # 远端 helper：远端空间账本
├── remote-lifecycle-probe.test.py # 远端 helper：持久任务生命周期探针
├── remote-reclaim.test.py         # 远端 helper：到期回收
├── remote-space-report.test.py    # 远端 helper：空间报告
└── remote-discovery.test.py       # 远端 helper：环境发现
```

以下「测试覆盖范围」各节描述的是上游继承测试（命令行/SSH 解析/连接管理/集成）的覆盖点；工作区、任务、传输、维护与 setup 等本 fork 新增能力的覆盖见上表对应文件与各设计文档。

## 运行测试

### 运行所有测试

```bash
npm test
```

### 监听模式（开发时使用）

```bash
npm run test:watch
```

监听模式会在文件变化时自动重新运行测试。

### 运行单个测试文件

```bash
node --test test/ssh-config-parser.test.js
```

## 测试覆盖范围

### 1. SSH Config Parser 测试

测试 `src/utils/ssh-config-parser.ts` 的功能：

- ✅ 基本 Host 别名解析
- ✅ 多别名 Host 行（`Host a b c`）
- ✅ 通配符匹配（`Host *.example.com`）
- ✅ `Host *` 默认值 fallback
- ✅ `Include` 指令支持
- ✅ 路径展开（`~` 和相对路径）
- ✅ First-match-wins 语义
- ✅ 错误处理（文件不存在等）

### 2. Command Line Parser 测试

测试 `src/cli/command-line-parser.ts` 的功能：

- ✅ JSON 配置文件解析（对象和数组格式）
- ✅ `--ssh` 参数解析（JSON 和旧格式）
- ✅ 单连接模式（命令行参数和位置参数）
- ✅ SSH config 集成
- ✅ 参数优先级（命令行 > SSH config）
- ✅ 命令白名单和黑名单
- ✅ 其他选项（`--pty`, `--pre-connect`, `--proxy`, `--socksProxy`）
- ✅ 错误处理

### 3. SSH Connection Manager 测试

测试 `src/services/ssh-connection-manager.ts` 的功能：

- ✅ 配置管理（初始化、获取配置）
- ✅ 命令验证（白名单、黑名单、正则表达式）
- ✅ 连接状态管理
- ✅ 多服务器支持

### 4. 集成测试

端到端测试完整流程：

- ✅ 从命令行参数到连接管理器的完整流程
- ✅ 从 SSH config 到连接管理器的完整流程
- ✅ 多服务器配置场景
- ✅ 错误处理（无效配置、缺少字段等）

## 编写新测试

### 测试文件命名

测试文件应该以 `.test.js` 结尾，并放在 `test/` 目录下。

### 测试示例

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('功能模块名称', () => {
  before(() => {
    // 测试前的准备工作
  });

  after(() => {
    // 测试后的清理工作
  });

  describe('子功能', () => {
    it('应该做某事', () => {
      // 测试代码
      assert.strictEqual(1 + 1, 2);
    });

    it('应该处理错误情况', () => {
      assert.throws(() => {
        throw new Error('测试错误');
      }, /测试错误/);
    });
  });
});
```

## 测试最佳实践

1. **独立性**：每个测试应该独立运行，不依赖其他测试的状态
2. **清理**：使用 `after` 钩子清理测试创建的临时文件和资源
3. **描述性**：测试名称应该清楚地描述测试的内容
4. **覆盖边界情况**：测试正常情况、边界情况和错误情况
5. **使用 fixtures**：将测试数据放在 `test/fixtures/` 目录下

## CI/CD 集成

测试可以轻松集成到 CI/CD 流程中：

```yaml
# GitHub Actions 示例
- name: Run tests
  run: npm test
```

## 调试测试

### 使用 Node.js 调试器

```bash
node --inspect-brk --test test/ssh-config-parser.test.js
```

然后在 Chrome 中打开 `chrome://inspect` 进行调试。

### 查看详细输出

```bash
node --test --test-reporter=tap test/**/*.test.js
```

## 常见问题

### Q: 测试失败但没有详细错误信息？

A: 使用 `--test-reporter=spec` 查看详细输出：

```bash
node --test --test-reporter=spec test/**/*.test.js
```

### Q: 如何跳过某个测试？

A: 使用 `it.skip()`:

```javascript
it.skip('暂时跳过的测试', () => {
  // 测试代码
});
```

### Q: 如何只运行某个测试？

A: 使用 `it.only()`:

```javascript
it.only('只运行这个测试', () => {
  // 测试代码
});
```

## 贡献指南

提交 PR 时，请确保：

1. 所有测试通过：`npm test`
2. 新功能有对应的测试
3. 测试覆盖了正常情况和边界情况
4. 代码编译通过：`npm run build`
