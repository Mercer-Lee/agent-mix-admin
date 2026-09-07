import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

export interface InvokableAgent {
  id: string;
  slug: string;
  name: string;
  description: string;
}

@Injectable()
export class AgentAccessService {
  constructor(private readonly database: DatabaseService) {}

  async canInvoke(userSubjectId: string, agentSubjectId: string): Promise<boolean> {
    const result = await this.database.pool.query<{ allowed: boolean }>(
      `with recursive department_lineage as (
         select d.id, d.parent_id, 0 as depth, array[d.id]::uuid[] as path
           from departments d
           join users u on u.department_id = d.id
          where u.subject_id = $1 and d.status = 'active'
         union all
         select parent.id, parent.parent_id, child.depth + 1, child.path || parent.id
           from departments parent
           join department_lineage child on child.parent_id = parent.id
          where parent.status = 'active'
            and not parent.id = any(child.path)
       )
       select exists (
         select 1
           from agents a
           join subjects agent_subject on agent_subject.id = a.subject_id
          where a.subject_id = $2
            and agent_subject.status = 'active'
            and (
              exists (
                select 1 from agent_user_access_grants grant_row
                 where grant_row.agent_subject_id = a.subject_id
                   and grant_row.user_subject_id = $1
              )
              or exists (
                select 1
                  from agent_role_access_grants grant_row
                  join subject_roles assignment
                    on assignment.role_id = grant_row.role_subject_id
                   and assignment.subject_id = $1
                  join subjects role_subject on role_subject.id = grant_row.role_subject_id
                 where grant_row.agent_subject_id = a.subject_id
                   and role_subject.status = 'active'
              )
              or exists (
                select 1
                  from agent_department_access_grants grant_row
                  join department_lineage lineage on lineage.id = grant_row.department_id
                 where grant_row.agent_subject_id = a.subject_id
                   and (lineage.depth = 0 or grant_row.include_descendants)
              )
            )
       ) as allowed`,
      [userSubjectId, agentSubjectId],
    );
    return result.rows[0]?.allowed ?? false;
  }

  async listAvailable(userSubjectId: string): Promise<InvokableAgent[]> {
    const result = await this.database.pool.query<InvokableAgent>(
      `with recursive department_lineage as (
         select d.id, d.parent_id, 0 as depth, array[d.id]::uuid[] as path
           from departments d
           join users u on u.department_id = d.id
          where u.subject_id = $1 and d.status = 'active'
         union all
         select parent.id, parent.parent_id, child.depth + 1, child.path || parent.id
           from departments parent
           join department_lineage child on child.parent_id = parent.id
          where parent.status = 'active'
            and not parent.id = any(child.path)
       )
       select a.subject_id as id, a.slug, a.name, a.description
         from agents a
         join subjects agent_subject on agent_subject.id = a.subject_id
         join agent_runtimes runtime on runtime.agent_subject_id = a.subject_id
         join model_profiles profile on profile.id = runtime.model_profile_id
        where agent_subject.status = 'active'
          and profile.status = 'active'
          and (
            exists (
              select 1 from agent_user_access_grants grant_row
               where grant_row.agent_subject_id = a.subject_id
                 and grant_row.user_subject_id = $1
            )
            or exists (
              select 1
                from agent_role_access_grants grant_row
                join subject_roles assignment
                  on assignment.role_id = grant_row.role_subject_id
                 and assignment.subject_id = $1
                join subjects role_subject on role_subject.id = grant_row.role_subject_id
               where grant_row.agent_subject_id = a.subject_id
                 and role_subject.status = 'active'
            )
            or exists (
              select 1
                from agent_department_access_grants grant_row
                join department_lineage lineage on lineage.id = grant_row.department_id
               where grant_row.agent_subject_id = a.subject_id
                 and (lineage.depth = 0 or grant_row.include_descendants)
            )
          )
        order by a.name`,
      [userSubjectId],
    );
    return result.rows;
  }
}
