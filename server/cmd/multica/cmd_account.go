package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// Account commands — workspace env sets agents opt into (e.g. two Claude
// subscriptions). Writes need workspace owner/admin. Env values are write-only
// here: they go in through --env-file / --env-stdin, as with custom_env, and
// never come back in list or update output.

var accountCmd = &cobra.Command{
	Use:   "account",
	Short: "Work with accounts (named env sets agents can run with)",
}

var accountListCmd = &cobra.Command{
	Use:   "list",
	Short: "List accounts in the workspace",
	RunE:  runAccountList,
}

var accountCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an account (workspace owner/admin)",
	RunE:  runAccountCreate,
}

var accountUpdateCmd = &cobra.Command{
	Use:   "update <name|id>",
	Short: "Update an account (workspace owner/admin; env values equal to **** preserve the existing entry)",
	Args:  exactArgs(1),
	RunE:  runAccountUpdate,
}

var accountDeleteCmd = &cobra.Command{
	Use:   "delete <name|id>",
	Short: "Delete an account no agent uses (workspace owner/admin)",
	Args:  exactArgs(1),
	RunE:  runAccountDelete,
}

func init() {
	accountCmd.AddCommand(accountListCmd)
	accountCmd.AddCommand(accountCreateCmd)
	accountCmd.AddCommand(accountUpdateCmd)
	accountCmd.AddCommand(accountDeleteCmd)

	accountListCmd.Flags().String("output", "table", "Output format: table or json")

	accountCreateCmd.Flags().String("name", "", "Account name (required)")
	accountCreateCmd.Flags().String("provider", "", "Runtime provider the account is for, e.g. claude or codex (required)")
	accountCreateCmd.Flags().Bool("env-stdin", false, "Read the env JSON object from stdin. Mutually exclusive with --env-file.")
	accountCreateCmd.Flags().String("env-file", "", "Read the env JSON object from a file path (suggested mode: 0600). Mutually exclusive with --env-stdin.")
	accountCreateCmd.Flags().Bool("override-runtime-default", false, "Agents on \"Runtime default\" for this provider run with this account (moves the override from any other account of the provider)")
	accountCreateCmd.Flags().String("output", "json", "Output format: table or json")

	accountUpdateCmd.Flags().String("name", "", "New name")
	accountUpdateCmd.Flags().String("provider", "", "New provider (rejected while agents use the account)")
	accountUpdateCmd.Flags().Bool("env-stdin", false, "Read the replacement env JSON object from stdin. Values equal to '****' preserve the existing entry; pass '{}' to clear. Mutually exclusive with --env-file.")
	accountUpdateCmd.Flags().String("env-file", "", "Read the replacement env JSON object from a file path (suggested mode: 0600). Mutually exclusive with --env-stdin.")
	accountUpdateCmd.Flags().Bool("override-runtime-default", false, "Turn the runtime-default override on (true) or off (=false) for this account")
	accountUpdateCmd.Flags().String("output", "json", "Output format: table or json")
}

func fetchAccounts(ctx context.Context, client *cli.APIClient) ([]map[string]any, error) {
	var resp struct {
		Accounts []map[string]any `json:"accounts"`
	}
	if err := client.GetJSON(ctx, "/api/accounts", &resp); err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	return resp.Accounts, nil
}

// resolveAccountID matches an exact id first, then an exact name.
func resolveAccountID(ctx context.Context, client *cli.APIClient, ref string) (string, error) {
	accounts, err := fetchAccounts(ctx, client)
	if err != nil {
		return "", err
	}
	for _, a := range accounts {
		if strVal(a, "id") == ref {
			return ref, nil
		}
	}
	for _, a := range accounts {
		if strVal(a, "name") == ref {
			return strVal(a, "id"), nil
		}
	}
	return "", fmt.Errorf("account %q not found", ref)
}

func printAccount(cmd *cobra.Command, verb string, account map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, account)
	}
	fmt.Printf("Account %s: %s (%s)\n", verb, strVal(account, "name"), strVal(account, "id"))
	return nil
}

func runAccountList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	if _, err := requireWorkspaceID(cmd); err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	accounts, err := fetchAccounts(ctx, client)
	if err != nil {
		return err
	}
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, accounts)
	}
	headers := []string{"ID", "NAME", "PROVIDER", "KEYS", "RUNTIME DEFAULT"}
	rows := make([][]string, 0, len(accounts))
	for _, a := range accounts {
		keys := ""
		if n, ok := a["env_key_count"].(float64); ok {
			keys = strconv.Itoa(int(n))
		}
		override := ""
		if v, _ := a["overrides_runtime_default"].(bool); v {
			override = "override"
		}
		rows = append(rows, []string{strVal(a, "id"), strVal(a, "name"), strVal(a, "provider"), keys, override})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func runAccountCreate(cmd *cobra.Command, _ []string) error {
	name, _ := cmd.Flags().GetString("name")
	provider, _ := cmd.Flags().GetString("provider")
	if strings.TrimSpace(name) == "" || strings.TrimSpace(provider) == "" {
		return fmt.Errorf("--name and --provider are required")
	}
	env, _, err := resolveEnvFlags(cmd, "env")
	if err != nil {
		return err
	}
	if env == nil {
		env = map[string]string{}
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	override, _ := cmd.Flags().GetBool("override-runtime-default")
	var result map[string]any
	body := map[string]any{"name": name, "provider": provider, "env": env, "overrides_runtime_default": override}
	if err := client.PostJSON(ctx, "/api/accounts", body, &result); err != nil {
		return fmt.Errorf("create account: %w", err)
	}
	return printAccount(cmd, "created", result)
}

func runAccountUpdate(cmd *cobra.Command, args []string) error {
	body := map[string]any{}
	if cmd.Flags().Changed("name") {
		v, _ := cmd.Flags().GetString("name")
		body["name"] = v
	}
	if cmd.Flags().Changed("provider") {
		v, _ := cmd.Flags().GetString("provider")
		body["provider"] = v
	}
	if cmd.Flags().Changed("override-runtime-default") {
		v, _ := cmd.Flags().GetBool("override-runtime-default")
		body["overrides_runtime_default"] = v
	}
	env, ok, err := resolveEnvFlags(cmd, "env")
	if err != nil {
		return err
	}
	if ok {
		body["env"] = env
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update — provide --name, --provider, --override-runtime-default, --env-file, or --env-stdin")
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	id, err := resolveAccountID(ctx, client, args[0])
	if err != nil {
		return err
	}
	var result map[string]any
	if err := client.PutJSON(ctx, "/api/accounts/"+id, body, &result); err != nil {
		return fmt.Errorf("update account: %w", err)
	}
	return printAccount(cmd, "updated", result)
}

func runAccountDelete(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	id, err := resolveAccountID(ctx, client, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, "/api/accounts/"+id); err != nil {
		return fmt.Errorf("delete account: %w", err)
	}
	fmt.Printf("Account deleted: %s\n", args[0])
	return nil
}

// applyAccountFlag maps `agent update --account <name|id|none>` onto the
// account_id field; "none" selects the runtime default.
func applyAccountFlag(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, body map[string]any) error {
	if !cmd.Flags().Changed("account") {
		return nil
	}
	ref, _ := cmd.Flags().GetString("account")
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return fmt.Errorf("--account requires an account name or id, or 'none' for the runtime default")
	}
	if strings.EqualFold(ref, "none") {
		body["account_id"] = nil
		return nil
	}
	id, err := resolveAccountID(ctx, client, ref)
	if err != nil {
		return err
	}
	body["account_id"] = id
	return nil
}
