-- 满额置位与运维复位各自推进代次；旧镜像插入仍可省略此列。
ALTER TABLE public.sandbox_wecom_state ADD COLUMN full_revision bigint NOT NULL DEFAULT 0;
