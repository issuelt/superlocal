// Superlocal's own oxlint rules, loaded through `jsPlugins` in .oxlintrc.json.
// Adapted from t3code's oxlint-plugin-t3code (MIT). Each rule encodes a
// correction we would otherwise repeat in review.
import { definePlugin, defineRule, type ESTree } from "@oxlint/plugins";

const EM_DASH = "—";

// Comments are not product copy, so only string and JSX text nodes are checked.
const noEmDashCopy = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow em dashes in strings and JSX text that people read." },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string | null | undefined) => {
      if (text?.includes(EM_DASH)) {
        context.report({
          node,
          message:
            "No em dashes in product copy. Use a period, comma, colon, or parentheses instead.",
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
});

const DIRECTIVE_PATTERN =
  /^\s*\*?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck))/u;
const TS_DIRECTIVE_PATTERN = /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;
const EMPTY_COMMENT_PATTERN = /^[\s*]*$/u;

// A suppression passes when it ends with `-- reason`, has text after a
// `@ts-*` directive, or sits under an explanatory comment.
const requireSuppressionReason = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Require every lint or type-checker suppression to say why." },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        const ownLineCommentsByEndLine = new Map<number, ESTree.Comment>();
        for (const comment of comments) {
          const { line, column } = comment.loc.start;
          if ((sourceCode.lines[line - 1] ?? "").slice(0, column).trim() === "") {
            ownLineCommentsByEndLine.set(comment.loc.end.line, comment);
          }
        }

        const explainedAbove = (directive: ESTree.Comment) => {
          let above = ownLineCommentsByEndLine.get(directive.loc.start.line - 1);
          while (
            above &&
            (DIRECTIVE_PATTERN.test(above.value) || EMPTY_COMMENT_PATTERN.test(above.value))
          ) {
            above = ownLineCommentsByEndLine.get(above.loc.start.line - 1);
          }
          return above !== undefined;
        };

        for (const directive of sourceCode.getDisableDirectives().directives) {
          if (directive.type === "enable" || directive.justification?.trim()) continue;
          if (explainedAbove(directive.node)) continue;
          context.report({
            loc: directive.node.loc,
            message:
              "Say why: end the directive with `-- reason` or put a comment on the line above.",
          });
        }

        for (const comment of comments) {
          const after = TS_DIRECTIVE_PATTERN.exec(comment.value)?.[1];
          if (after === undefined || after.replace(/^[\s:-]+/u, "").trim()) continue;
          if (explainedAbove(comment)) continue;
          context.report({
            loc: comment.loc,
            message:
              "Say why: write the reason after the directive or in a comment on the line above.",
          });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "superlocal" },
  rules: {
    "no-em-dash-copy": noEmDashCopy,
    "require-suppression-reason": requireSuppressionReason,
  },
});
