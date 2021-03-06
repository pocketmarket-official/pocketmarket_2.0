import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { Restaurant } from './../restaurants/entities/restaurant.entity';
import { Item } from './../restaurants/entities/item.entity';
import { Option } from './../restaurants/entities/option.entity';
import { OrderMenu } from './entities/order-menu.entity';
import { PubSub } from 'graphql-subscriptions';
import { NEW_COOKED_ORDER, NEW_PENDING_ORDER, PUB_SUB, NEW_ORDER_UPDATE } from './../core/core.constants';
import { User, UserRole } from './../users/entities/user.entity';
import { CreateOrderInput, CreateOrderOutput } from './dtos/create-order.dto';
import { GetOrdersOutput } from './dtos/get-orders.dto';
import { GetOrderInput, GetOrderOutput } from './dtos/get-order.dto';
import { EditOrderInput, EditOrderOutput } from './dtos/edit-order.dto';

@Injectable()
export class OrdersService {
    constructor(
        @InjectRepository(Order) private readonly orders: Repository<Order>,
        @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
        @InjectRepository(Item) private readonly items: Repository<Item>,
        @InjectRepository(Option) private readonly options: Repository<Option>,
        @InjectRepository(OrderMenu) private readonly ordermenus: Repository<OrderMenu>,
        @Inject(PUB_SUB) private readonly pubSub: PubSub,
    ) {}

    async createOrder(
        customer: User,
        { restaurantId, items }: CreateOrderInput
    ): Promise<CreateOrderOutput> {
        try {
            const restaurant = await this.restaurants.findOne(restaurantId);
            let totalPrice = 0;
            const orderItems: OrderMenu[] = [];
            if(!restaurant) {
                return {
                    accepted: false,
                    error: "Restaurant Not Found",
                };
            }
            // use for of loop, NOT forEach
            // you cannot return things inside forEach
            for(const elt of items) {
                const item = await this.items.findOne(elt.itemId);
                const option = await this.options.find({ item });
                if(!item) {
                    // abort whole thing!
                    return {
                        accepted: false,
                        error: "Invalid Order",
                    };
                }
                // ?????? ?????? * ??????
                let itemPrice = item.price * elt.count;
                if(elt.options) {
                    // calculate total price
                    for(const target of elt.options) {
                        // ???????????? option ?????? ??????
                        const result = option.find(e => e.name === target.name);
                        if(result) {
                            for(const choice of result.choices) {
                                if(choice.name === target.choice) {
                                    // ?????? ?????? * ?????? ??????
                                    itemPrice += choice.price * elt.count;
                                }
                            }
                        }
                    }
                }
                // ???????????? ?????? ?????? ??? ??????
                totalPrice += itemPrice;
                const orderItem = await this.ordermenus.save(this.ordermenus.create({
                    item,
                    count: elt.count,
                    options: elt.options,
                }));
                orderItems.push(orderItem);
            }
            const order = await this.orders.save(this.orders.create({
                customer,
                restaurant,
                total: totalPrice,
                items: orderItems,
            }));
            await this.pubSub.publish(NEW_PENDING_ORDER, {
                pendingOrders: { order, ownerId: restaurant.ownerId }
            });
           return {
               accepted: true,
           }
        } catch (e) {
            return {
                accepted: false,
                error: "Could not create order",
            };
        }
    }

    // ??????
    async getOrders(
        user: User,
    ): Promise<GetOrdersOutput> {
        try {
            let orders: Order[];
            if(user.role === UserRole.Client) {
                orders = await this.orders.find({
                    where: {
                        customer: user,
                    }
                });
            } else if(user.role === UserRole.Owner) {
                const restaurants = await this.restaurants.find({
                    where: {
                        owner: user,
                    },
                    relations: ['orders'],
                });
                orders = restaurants.map(restaurant => restaurant.orders).flat(1);
            } else if(user.role === UserRole.Admin) {
                orders = await this.orders.find();
            }
            return {
                accepted: true,
                orders,
            };
        } catch (e) {
            return {
                accepted: false,
                error: "Could not load orders",
            };
        }
    }

    // ?????? ?????? ??????
    __canSeeOrder(
        user: User,
        order: Order
    ): boolean {
        let canSee = false;
        // ????????? ????????? ????????????
        if(user.id === order.customerId) {
            canSee = true;
        }
        // ????????? ?????? ????????? ???
        if(user.id === order.restaurant.ownerId) {
            canSee = true;
        }
        // admin ????????? ?????? ?????? ?????? ?????? ??????
        if(user.role === UserRole.Admin) {
            canSee = true;
        }
        return canSee;
    }

    async getOrder(
        user: User,
        { id: orderId }: GetOrderInput,
    ): Promise<GetOrderOutput> {
        try {
            const order = await this.orders.findOne(orderId, {
                relations: ['restaurant'],
            });
            if(!order) {
                return {
                    accepted: false,
                    error: "Order Not Found",
                };
            }
            if(!this.__canSeeOrder(user, order)) {
                return {
                    accepted: false,
                    error: "Access Not Allowed",
                };
            }
            return {
                accepted: true,
                order,
            };
        } catch (e) {
            return {
                accepted: false,
                error: "Could not load order",
            };
        }
    }

    // ?????? ?????? ??????
    async editOrderStatus(
        user: User,
        { id: orderId }: EditOrderInput
    ): Promise<EditOrderOutput> {
        try {
            const order = await this.orders.findOne(orderId);
            if(!order) {
                return {
                    accepted: false,
                    error: "Order Not Found",
                };
            }
            if(!this.__canSeeOrder(user, order)) {
                return {
                    accepted: false,
                    error: "Access Not Allowed",
                };
            }
            let canEdit: boolean = false;
            let status: OrderStatus = OrderStatus.Pending;
            // status?????? ?????? ?????? ?????? ??????
            if(order.status === OrderStatus.Pending || order.status === OrderStatus.Cooking) {
                // ?????? ????????? ?????? ??????
                if(user.id === order.restaurant.ownerId) {
                    canEdit = true;
                    if(order.status === OrderStatus.Pending) {
                        status = OrderStatus.Cooking;
                    } else if(order.status === OrderStatus.Cooking) {
                        status = OrderStatus.Cooked;
                    }
                }
            } else if(order.status === OrderStatus.Cooked) {
                // ????????? ?????? ??? ?????? ??????
                // ????????? ???????????????
                // ?????? ????????? ?????? ??? ?????? ?????? ??????
                if(user.id === order.customerId) {
                    canEdit = true;
                    status = OrderStatus.PickedUp;
                }

                if(user.id === order.restaurant.ownerId) {
                    canEdit = true;
                    status = OrderStatus.PickedUp;
                }
            } else if(order.status === OrderStatus.PickedUp) {
                // ????????? ????????? ????????? ???????????? ?????? ??????
                if(user.id === order.customerId) {
                    canEdit = true;
                    status = OrderStatus.Reviewed;
                }
            } else if(order.status === OrderStatus.Reviewed || order.status === OrderStatus.Aborted) {
                // ?????? ?????? ???????????? ?????? ?????? ????????? ?????? X
                // ????????? ????????? ??????????????? ????????? ?????? ?????? ?????????????????? ??????
                canEdit = false;
            }
            // admin??? ?????? ?????? ??????
            if(user.role === UserRole.Admin) {
                canEdit = true;
                if(order.status === OrderStatus.Pending) {
                    status = OrderStatus.Cooking;
                } else if(order.status === OrderStatus.Cooking) {
                    status = OrderStatus.Cooked;
                } else if(order.status === OrderStatus.Cooked) {
                    status = OrderStatus.PickedUp;
                } else if(order.status === OrderStatus.PickedUp) {
                    status = OrderStatus.Reviewed;
                } else {
                    canEdit = false;
                }
            }
            if(!canEdit) {
                return {
                    accepted: false,
                    error: "Not Permitted Behavior",
                };
            }

            await this.orders.save({
                id: orderId,
                status,
            });

            if(status === OrderStatus.Cooked) {
                await this.pubSub.publish(NEW_COOKED_ORDER, {
                    cookedOrders: {...order, status},
                });
            }
            await this.pubSub.publish(NEW_ORDER_UPDATE, { orderUpdates: {...order, status} });
            return {
                accepted: true,
            };
        } catch (e) {
            return {
                accepted: false,
                error: "Could not edit order status",
            };
        }
    }
}
