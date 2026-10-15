-- 06 R10：每轮回复的形状（类别、行数、字数、上限、裁掉句数）。可空：旧行与未进入主回复流水线的轮次为 NULL；
-- 继承 02 表级 SELECT、INSERT（agent_app 无 UPDATE、DELETE），不单独授权。回滚到本迁移之前的镜像时，旧代码不写也不读这一列。
ALTER TABLE "turn_traces" ADD COLUMN "reply_shape" json;
