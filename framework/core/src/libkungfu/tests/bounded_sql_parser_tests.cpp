// SPDX-License-Identifier: Apache-2.0
//
// ADR-0048 bounds the SQL frontend to a closed dialect, and compile_episode_sql
// is the trust boundary that keeps it closed: whatever this parser accepts is
// what reaches the query planner, and every widening of a character class or a
// length bound is a security decision.
//
// The dialect used to be two large regular expressions. When they were replaced
// by a tokenizer plus a recursive-descent parser, an offline differential
// harness proved the two implementations agreed on ~198k inputs (the corpus
// below plus byte-level mutation fuzz around it). That harness cannot live in
// the tree, because keeping the regexes to compare against would mean keeping
// two parsers. This corpus is what it leaves behind: the accepted language
// pinned as explicit expectations, so a later change to the parser has to state
// its intent here rather than silently move the boundary.
//
// Positive cases assert every captured field, not just that parsing succeeded —
// a parser that accepts the right sentences and captures the wrong values is
// the failure this file exists to catch.
#include <kungfu/runtime/query/fact_query.h>

#include <cstdio>
#include <exception>
#include <stdexcept>
#include <string>
#include <vector>

using kungfu::runtime::query::compile_episode_sql;
using kungfu::runtime::query::query_definition;

namespace {

void require(bool condition, const std::string &message) {
  if (not condition) {
    throw std::runtime_error(message);
  }
}

query_definition compile(const std::string &sql) { return compile_episode_sql(sql, query_definition{}); }

void accepts(const std::string &sql) {
  try {
    (void)compile(sql);
  } catch (const std::exception &error) {
    throw std::runtime_error("expected accepted SQL <<<" + sql + ">>> but it was rejected: " + error.what());
  }
}

void rejects(const std::string &sql) {
  try {
    (void)compile(sql);
  } catch (const std::invalid_argument &) {
    return;
  }
  throw std::runtime_error("expected rejected SQL <<<" + sql + ">>> but it was accepted");
}

// ---- the plain episode form -------------------------------------------------

void test_plain_form_captures_its_clauses() {
  const auto bare = compile("SELECT * FROM episodes");
  require(bare.basis.episode_id == 0, "bare select must not filter an episode");
  require(bare.limit == 100, "bare select must keep the base definition limit");
  require(not bare.has_temporal_pattern, "bare select must not carry a temporal pattern");

  const auto filtered = compile("SELECT * FROM episodes WHERE episode_id = 48 ORDER BY episode_id ASC LIMIT 5");
  require(filtered.basis.episode_id == 48, "WHERE episode_id must be captured");
  require(filtered.limit == 5, "LIMIT must be captured");
  require(not filtered.has_temporal_pattern, "plain select must not carry a temporal pattern");

  // The base definition owns episode_id; SQL without a WHERE clause clears it
  // rather than inheriting it.
  query_definition base;
  base.basis.episode_id = 77;
  const auto cleared = compile_episode_sql("SELECT * FROM episodes", base);
  require(cleared.basis.episode_id == 0, "SQL without WHERE must clear the inherited episode_id");
}

void test_plain_form_accepts_its_whitespace_and_case_variants() {
  accepts("select * from episodes");
  accepts("SeLeCt * FrOm EPISODES");
  accepts("SELECT * FROM episodes;");
  accepts("  SELECT * FROM episodes  ;  ");
  accepts("\t\n\v\f\r SELECT\t*\nFROM\repisodes\v;\f");
  accepts("SELECT * FROM episodes WHERE episode_id=48");
  accepts("SELECT * FROM episodes WHERE episode_id  =  48");
  accepts("SELECT * FROM episodes LIMIT 1");
  accepts("SELECT * FROM episodes LIMIT 1000");
  accepts("SELECT * FROM episodes WHERE episode_id = 0");
}

void test_plain_form_rejects_everything_else() {
  rejects("");
  rejects("   ");
  rejects(std::string(4097, 'x'));
  // Separators the dialect requires are not optional.
  rejects("SELECT*FROM episodes");
  rejects("SELECT *FROM episodes");
  rejects("SELECT * FROMepisodes");
  // The object is exactly "episodes".
  rejects("SELECT * FROM episodesx");
  rejects("SELECT * FROM episode");
  rejects("SELECT * FROM facts");
  rejects("SELECT id FROM episodes");
  // Clause order is fixed and the clause set is closed.
  rejects("SELECT * FROM episodes LIMIT 5 WHERE episode_id = 1");
  rejects("SELECT * FROM episodes ORDER BY episode_id ASC WHERE episode_id = 1");
  rejects("SELECT * FROM episodes ORDER BY episode_id DESC");
  rejects("SELECT * FROM episodes ORDER BY begin_time ASC");
  rejects("SELECT * FROM episodes WHERE episode_id > 4");
  rejects("SELECT * FROM episodes WHERE id = 4");
  rejects("SELECT * FROM episodes WHERE episode_id = 4 OR episode_id = 5");
  // Nothing is delegated to SQLite, so no second statement and no comments.
  rejects("SELECT * FROM episodes;;");
  rejects("SELECT * FROM episodes; SELECT * FROM episodes");
  rejects("SELECT * FROM episodes WHERE episode_id = 1; DROP TABLE episodes");
  rejects("SELECT * FROM episodes -- comment");
  rejects("SELECT * FROM episodes /* c */");
  rejects("SELECT * FROM episodes UNION SELECT * FROM episodes");
  rejects("SELECT * FROM (SELECT * FROM episodes)");
  rejects("SELECT * FROM episodes JOIN facts ON 1=1");
  // Numbers are unsigned decimal, bounded, and complete.
  rejects("SELECT * FROM episodes LIMIT 0");
  rejects("SELECT * FROM episodes LIMIT 1001");
  rejects("SELECT * FROM episodes LIMIT 12ab");
  rejects("SELECT * FROM episodes LIMIT");
  rejects("SELECT * FROM episodes LIMIT 99999999999999999999999999");
  rejects("SELECT * FROM episodes WHERE episode_id =");
  rejects("SELECT * FROM episodes WHERE episode_id = -1");
  rejects("SELECT * FROM episodes WHERE episode_id = 4.8");
  rejects("SELECT * FROM episodes WHERE episode_id = 99999999999999999999999999");
}

// ---- the MATCH_RECOGNIZE form ----------------------------------------------

constexpr const char *ATTENTION_SQL =
    "SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
    "DEFINE A AS title = 'alpha_published', B AS title = 'gate_failed' WITHIN 1000 AS OF 2000 "
    "ABSENT title = 'stable_published') LIMIT 10";

void test_match_recognize_captures_every_clause() {
  const auto compiled = compile(ATTENTION_SQL);
  require(compiled.has_temporal_pattern, "MATCH_RECOGNIZE must set a temporal pattern");
  require(compiled.basis.episode_id == 0, "MATCH_RECOGNIZE must clear episode_id");
  require(compiled.limit == 10, "trailing LIMIT must be captured");
  const auto &pattern = compiled.pattern;
  require(pattern.partition_by == "source", "PARTITION BY must be captured");
  require(pattern.order_by == "begin_time", "ORDER BY must be captured");
  require(pattern.repeat_min == 2 && pattern.repeat_max == 8, "PATTERN repeat bounds must be captured");
  require(pattern.sequence.size() == 2, "DEFINE must produce exactly two steps");
  require(pattern.sequence[0].field == "title" && pattern.sequence[0].equals == "alpha_published",
          "DEFINE A must be captured");
  require(pattern.sequence[1].field == "title" && pattern.sequence[1].equals == "gate_failed",
          "DEFINE B must be captured");
  require(pattern.within_ns == 1000, "WITHIN must be captured");
  require(pattern.as_of_time == 2000, "AS OF must be captured");
  require(pattern.has_absence, "ABSENT must set the absence flag");
  require(pattern.absence.field == "title" && pattern.absence.equals == "stable_published", "ABSENT must be captured");

  // ABSENT and the trailing LIMIT are both optional.
  const auto minimal =
      compile("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC "
              "PATTERN ((A B){2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  require(not minimal.pattern.has_absence, "ABSENT must stay optional");
  require(minimal.limit == 100, "omitted LIMIT must keep the base definition limit");
}

void test_match_recognize_normalizes_field_case_but_not_values() {
  // Field names are matched case-insensitively and folded to lower case; quoted
  // values are data and must survive verbatim.
  const auto compiled =
      compile("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY SOURCE ORDER BY BEGIN_TIME ASC "
              "PATTERN ((A B){2,8}) DEFINE A AS TITLE = 'Alpha_Published', B AS TITLE = 'gate_failed' "
              "WITHIN 1000 AS OF 2000)");
  require(compiled.pattern.partition_by == "source", "PARTITION BY must fold to lower case");
  require(compiled.pattern.order_by == "begin_time", "ORDER BY must fold to lower case");
  require(compiled.pattern.sequence[0].field == "title", "DEFINE field must fold to lower case");
  require(compiled.pattern.sequence[0].equals == "Alpha_Published", "a quoted value must keep its case");
}

void test_match_recognize_accepts_its_whitespace_variants() {
  // Every junction the dialect spells with optional whitespace, collapsed.
  accepts("SELECT * FROM episodes MATCH_RECOGNIZE(PARTITION BY source ORDER BY begin_time ASC PATTERN((A B){2,8}) "
          "DEFINE A AS title='alpha',B AS title='beta' WITHIN 1000 AS OF 2000)");
  // ...and expanded.
  accepts("SELECT * FROM episodes MATCH_RECOGNIZE ( PARTITION BY source ORDER BY begin_time ASC PATTERN ( ( A B ) "
          "{ 2 , 8 } ) DEFINE A AS title = 'alpha' , B AS title = 'beta' WITHIN 1000 AS OF 2000 "
          "ABSENT title = 'gamma' ) LIMIT 10 ;");
  // The multi-line form the CLI tests actually send.
  accepts("SELECT * FROM episodes MATCH_RECOGNIZE (\n"
          "      PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8})\n"
          "      DEFINE A AS title = 'alpha_published', B AS title = 'gate_failed'\n"
          "      WITHIN 1000 AS OF 2000 ABSENT title = 'stable_published'\n"
          "    ) LIMIT 10");
  accepts("select * from episodes match_recognize (partition by source order by begin_time asc pattern ((a b){2,8}) "
          "define a as title = 'alpha', b as title = 'beta' within 1000 as of 2000)");
}

void test_match_recognize_rejects_structural_breakage() {
  // Separators the dialect requires stay required.
  rejects("SELECT * FROM episodesMATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)LIMIT 10");
  // Unbalanced or missing structure.
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000");
  // Mandatory clauses are mandatory.
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a' B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000) LIMIT");
  // The pattern family stays closed: no alternation, no third step, no descent.
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A | B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B C){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time DESC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
}

void test_quoted_values_cannot_re_enter_the_grammar() {
  // No escape, no doubled quote, no unterminated quote, and no character
  // outside the value class: a value can never become syntax.
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a''b', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a\\'b', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a, B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a b', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a%b', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = 'a;DROP', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC PATTERN ((A B){2,8}) "
          "DEFINE A AS title = '', B AS title = 'b' WITHIN 1000 AS OF 2000)");
}

// The exact boundaries of the two length bounds and the value character class.
// These are the numbers an accidental widening would move first.
void test_value_class_and_length_bounds_are_exact() {
  const auto with_value = [](const std::string &value) {
    return "SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC "
           "PATTERN ((A B){2,8}) DEFINE A AS title = '" +
           value + "', B AS title = 'b' WITHIN 1000 AS OF 2000)";
  };
  // The value character class is the parser's alone: the planner bounds a
  // predicate value's length but never its characters, so these cases pin a
  // rule nothing downstream re-checks.
  accepts(with_value("aZ0_.:@/+-"));
  for (const char rejected : {' ', '%', '\\', '"', '*', '(', ')', ',', ';', '=', '#', '&', '$', '!', '~', '^'}) {
    rejects(with_value(std::string("a") + rejected + "b"));
  }
  // A quoted value holds 1..256 characters.
  accepts(with_value(std::string(256, 'v')));
  rejects(with_value(std::string(257, 'v')));

  // Field names must start with a letter and stay within 64 characters. The
  // parser enforces this, but so does the planner — and the planner also pins
  // every field to a whitelist, which rejects a 64-character name before its
  // length is ever in question. So the parser's own identifier bound is
  // defense in depth and is NOT observable from here: only its rejections are.
  // The offline differential harness that replaced the original regexes is what
  // pinned that bound exactly (64 accepted, 65 rejected) at the parser boundary.
  const auto with_field = [](const std::string &field) {
    return "SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC "
           "PATTERN ((A B){2,8}) DEFINE A AS " +
           field + " = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)";
  };
  accepts(with_field("title"));
  rejects(with_field("t" + std::string(64, 'x')));
  rejects(with_field("_title"));
  rejects(with_field("1title"));
}

// The parser is the trust boundary, but it is not the only one: the planner
// revalidates, so SQL cannot be used to route around QueryDefinition rules.
void test_planner_bounds_still_apply_through_sql() {
  const auto with_clause = [](const std::string &tail) {
    return "SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY begin_time ASC "
           "PATTERN ((A B)" +
           tail + ")";
  };
  // repeat must be 1 <= min <= max <= 16.
  rejects(with_clause("{0,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000"));
  rejects(with_clause("{2,17}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000"));
  rejects(with_clause("{8,2}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000"));
  // within_ns must be 1ns..30d, and as_of_time must be positive.
  rejects(with_clause("{2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 0 AS OF 2000"));
  rejects(with_clause("{2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 2592000000000001 AS OF 2000"));
  rejects(with_clause("{2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 0"));
  // Numbers that do not fit their type fail closed rather than wrapping.
  rejects(with_clause("{2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 9223372036854775808"));
  rejects(with_clause("{2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 99999999999999999999999 AS OF 2000"));
  // PARTITION BY is restricted to declared Episode fields; ORDER BY to times.
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY nonesuch ORDER BY begin_time ASC "
          "PATTERN ((A B){2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
  rejects("SELECT * FROM episodes MATCH_RECOGNIZE (PARTITION BY source ORDER BY nonesuch ASC "
          "PATTERN ((A B){2,8}) DEFINE A AS title = 'a', B AS title = 'b' WITHIN 1000 AS OF 2000)");
}

// A rejection has to say where it went wrong; "unsupported SQL" over a 4KB
// statement is not a diagnosis.
void test_rejections_locate_the_offending_token() {
  try {
    (void)compile("SELECT * FROM episodes ORDER BY episode_id DESC");
    throw std::runtime_error("expected the DESC statement to be rejected");
  } catch (const std::invalid_argument &error) {
    const std::string text = error.what();
    require(text.find("at byte 43") != std::string::npos, "rejection must point at the offending token, got: " + text);
    require(text.find("accepted forms") != std::string::npos, "rejection must still describe the accepted forms");
  }
}

} // namespace

int main() {
  // Report which contract point broke. An uncaught throw here would abort with
  // only "uncaught exception", leaving a CI failure undiagnosable from the log.
  try {
    test_plain_form_captures_its_clauses();
    test_plain_form_accepts_its_whitespace_and_case_variants();
    test_plain_form_rejects_everything_else();
    test_match_recognize_captures_every_clause();
    test_match_recognize_normalizes_field_case_but_not_values();
    test_match_recognize_accepts_its_whitespace_variants();
    test_match_recognize_rejects_structural_breakage();
    test_quoted_values_cannot_re_enter_the_grammar();
    test_value_class_and_length_bounds_are_exact();
    test_planner_bounds_still_apply_through_sql();
    test_rejections_locate_the_offending_token();
  } catch (const std::exception &error) {
    std::fprintf(stderr, "bounded SQL parser contract failed: %s\n", error.what());
    return 1;
  }
  return 0;
}
