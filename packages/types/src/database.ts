// Hand-rolled snapshot of the Supabase schema for the noelle project.
// REGENERATE after every migration with:
//   pnpm --filter @noelle/types generate
// (which runs `supabase gen types typescript --schema public,noelle`).
//
// Keeping a committed copy lets CI typecheck the downstream packages without
// needing live Supabase credentials.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
  noelle: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          slug: string;
          name: string;
          plan: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          plan?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          slug?: string;
          name?: string;
          plan?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      org_members: {
        Row: {
          org_id: string;
          user_id: string;
          role: string;
          created_at: string;
        };
        Insert: {
          org_id: string;
          user_id: string;
          role?: string;
          created_at?: string;
        };
        Update: {
          org_id?: string;
          user_id?: string;
          role?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey";
            columns: ["org_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      agent_instances: {
        Row: {
          id: string;
          org_id: string;
          role: string;
          status: string;
          display_name: string | null;
          model_overrides: Json;
          budget_cap_cents: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          role: string;
          status?: string;
          display_name?: string | null;
          model_overrides?: Json;
          budget_cap_cents?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          role?: string;
          status?: string;
          display_name?: string | null;
          model_overrides?: Json;
          budget_cap_cents?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_instances_org_id_fkey";
            columns: ["org_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      leads: {
        Row: {
          id: string;
          external_id: string;
          org_id: string;
          payload: Json;
          synced_at: string;
        };
        Insert: {
          id?: string;
          external_id: string;
          org_id: string;
          payload: Json;
          synced_at?: string;
        };
        Update: {
          id?: string;
          external_id?: string;
          org_id?: string;
          payload?: Json;
          synced_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "synced_leads_org_id_fkey";
            columns: ["org_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      drafts: {
        Row: {
          id: string;
          lead_id: string;
          org_id: string;
          payload: Json;
          synced_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          org_id: string;
          payload: Json;
          synced_at?: string;
        };
        Update: {
          id?: string;
          lead_id?: string;
          org_id?: string;
          payload?: Json;
          synced_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "synced_drafts_org_id_fkey";
            columns: ["org_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "drafts_lead_id_fkey";
            columns: ["lead_id"];
            referencedRelation: "leads";
            referencedColumns: ["id"];
          }
        ];
      };
      approvals: {
        Row: {
          id: string;
          org_id: string;
          agent_instance_id: string;
          draft_id: string;
          lead_id: string;
          status: string;
